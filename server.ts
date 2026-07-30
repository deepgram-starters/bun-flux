/**
 * Bun Flux Starter - Backend Server
 *
 * Simple WebSocket proxy to Deepgram's Flux API.
 * Forwards all messages (JSON and binary) bidirectionally between client and Deepgram.
 *
 * Key Features:
 * - WebSocket endpoint: /api/flux
 * - Bidirectional audio/transcription streaming via Flux (v2) API
 * - JWT session auth for API protection
 * - Native Bun.serve() with built-in WebSocket support
 * - No external web framework needed
 *
 * Routes:
 *   GET  /api/session              - Issue JWT session token
 *   GET  /api/metadata             - Project metadata from deepgram.toml
 *   WS   /api/flux                 - WebSocket proxy to Deepgram Flux (auth required)
 */

import { readFileSync } from "fs";
import { join } from "path";
import { sign, verify } from "jsonwebtoken";
import TOML from "@iarna/toml";
import type { ServerWebSocket } from "bun";
import { DeepgramClient } from "@deepgram/sdk";

// ============================================================================
// CONFIGURATION - Customize these values for your needs
// ============================================================================

/**
 * Server configuration - These can be overridden via environment variables
 */
interface ServerConfig {
  deepgramApiKey: string;
  port: number;
  host: string;
}

// Validate required environment variables
if (!process.env.DEEPGRAM_API_KEY) {
  console.error("ERROR: DEEPGRAM_API_KEY environment variable is required");
  console.error("Please copy sample.env to .env and add your API key");
  process.exit(1);
}

const CONFIG: ServerConfig = {
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  port: parseInt(process.env.PORT || "8081"),
  host: process.env.HOST || "0.0.0.0",
};

// ============================================================================
// DEEPGRAM SDK CLIENT
// ============================================================================

// A single SDK client is reused across connections; the API key is resolved
// here so the browser never sees it. Flux transcription uses the v2 listen
// websocket, which the SDK manages (auth, framing, reconnection).
//
// DEEPGRAM_BASE_URL (e.g. a staging host like wss://api.staging.deepgram.com)
// overrides the default production endpoint.
const baseUrl = process.env.DEEPGRAM_BASE_URL;
const deepgram = new DeepgramClient({
  apiKey: CONFIG.deepgramApiKey,
  ...(baseUrl
    ? {
        environment: {
          base: baseUrl
            .replace(/^wss:\/\//, "https://")
            .replace(/^ws:\/\//, "http://"),
          production: baseUrl,
          agent: baseUrl,
          agentRest: baseUrl
            .replace(/^wss:\/\//, "https://")
            .replace(/^ws:\/\//, "http://"),
        },
      }
    : {}),
});
if (baseUrl) {
  console.log(`Using custom Deepgram base URL: ${baseUrl}`);
}

// ============================================================================
// SESSION AUTH - JWT tokens for production security
// ============================================================================

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.getRandomValues(new Uint8Array(32)).reduce(
    (s, b) => s + b.toString(16).padStart(2, "0"),
    ""
  );

const JWT_EXPIRY = "1h";

// ============================================================================
// TYPES - TypeScript interfaces for WebSocket data context
// ============================================================================

/**
 * Data attached to each upgraded WebSocket connection via server.upgrade().
 * Bun's centralized handlers access this via ws.data.
 */
interface WsData {
  url: string;
  /** SDK Flux (listen.v2) connection object for this client. */
  dgConn: any;
  /** True once the Deepgram connection has opened and buffered frames flushed. */
  dgReady: boolean;
  /** Browser frames received before the Deepgram socket opened. */
  pending: Array<{ binary: boolean; data: any }>;
  clientMessageCount: number;
  deepgramMessageCount: number;
}

// Track all active client connections for graceful shutdown
const activeConnections = new Set<ServerWebSocket<WsData>>();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validates JWT from WebSocket subprotocol: access_token.<jwt>
 * Returns the token protocol string if valid, null if invalid.
 */
function validateWsToken(protocols: string | undefined): string | null {
  if (!protocols) return null;
  const list = protocols.split(",").map((s) => s.trim());
  const tokenProto = list.find((p) => p.startsWith("access_token."));
  if (!tokenProto) return null;
  const token = tokenProto.slice("access_token.".length);
  try {
    verify(token, SESSION_SECRET);
    return tokenProto;
  } catch {
    return null;
  }
}

/**
 * Build the Flux (listen.v2) connection options from client query parameters.
 * Model is hardcoded to flux-general-en. Optional EOT tuning and multi-value
 * keyterm parameters are only included when the client supplied them.
 */
function buildFluxOptions(queryParams: URLSearchParams): Record<string, unknown> {
  const options: Record<string, unknown> = {
    model: "flux-general-en",
    encoding: queryParams.get("encoding") || "linear16",
    sample_rate: queryParams.get("sample_rate") || "16000",
  };

  // Optional Flux-specific end-of-turn tuning parameters
  const eotThreshold = queryParams.get("eot_threshold");
  if (eotThreshold) options.eot_threshold = eotThreshold;

  const eagerEotThreshold = queryParams.get("eager_eot_threshold");
  if (eagerEotThreshold) options.eager_eot_threshold = eagerEotThreshold;

  const eotTimeoutMs = queryParams.get("eot_timeout_ms");
  if (eotTimeoutMs) options.eot_timeout_ms = eotTimeoutMs;

  // Multi-value keyterm support — pass through as an array when present
  const keyterms = queryParams.getAll("keyterm");
  if (keyterms.length) options.keyterm = keyterms;

  return options;
}

/**
 * Read and parse deepgram.toml for metadata endpoint
 */
function readMetadata(): Record<string, unknown> | null {
  try {
    const tomlPath = join(import.meta.dir, "deepgram.toml");
    const tomlContent = readFileSync(tomlPath, "utf-8");
    const config = TOML.parse(tomlContent);
    return (config.meta as Record<string, unknown>) || null;
  } catch {
    return null;
  }
}

/**
 * CORS headers for API responses
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ============================================================================
// SERVER - Bun.serve() with HTTP and WebSocket handling
// ============================================================================

const server = Bun.serve<WsData>({
  port: CONFIG.port,
  hostname: CONFIG.host,

  /**
   * HTTP request handler for REST endpoints and WebSocket upgrades
   */
  async fetch(req, server) {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // -------------------------------------------------------------------
    // GET /api/session — Issues a signed JWT for session authentication
    // -------------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/session") {
      const token = sign(
        { iat: Math.floor(Date.now() / 1000) },
        SESSION_SECRET,
        { expiresIn: JWT_EXPIRY }
      );
      return Response.json(
        { token },
        { headers: CORS_HEADERS }
      );
    }

    // -------------------------------------------------------------------
    // GET /api/metadata — Project metadata from deepgram.toml
    // -------------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/metadata") {
      const meta = readMetadata();
      if (!meta) {
        return Response.json(
          {
            error: "INTERNAL_SERVER_ERROR",
            message: "Missing [meta] section in deepgram.toml",
          },
          { status: 500, headers: CORS_HEADERS }
        );
      }
      return Response.json(meta, { headers: CORS_HEADERS });
    }

    // -------------------------------------------------------------------
    // GET /health — Simple health check endpoint
    // -------------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" }, { headers: CORS_HEADERS });
    }

    // -------------------------------------------------------------------
    // WS /api/flux — WebSocket proxy to Deepgram Flux (auth required)
    // -------------------------------------------------------------------
    if (url.pathname === "/api/flux") {
      const upgrade = req.headers.get("upgrade") || "";
      if (upgrade.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", {
          status: 426,
          headers: CORS_HEADERS,
        });
      }

      // Validate JWT from subprotocol
      const protocols = req.headers.get("sec-websocket-protocol") || "";
      const validProto = validateWsToken(protocols);
      if (!validProto) {
        console.log("WebSocket auth failed: invalid or missing token");
        return new Response("Unauthorized", {
          status: 401,
          headers: CORS_HEADERS,
        });
      }

      // Upgrade the connection — data is available in ws.data in handlers
      const success = server.upgrade(req, {
        data: {
          url: req.url,
          dgConn: null,
          dgReady: false,
          pending: [],
          clientMessageCount: 0,
          deepgramMessageCount: 0,
        },
        headers: {
          "Sec-WebSocket-Protocol": validProto,
        },
      });

      if (success) {
        // Bun returns undefined on successful upgrade
        return undefined as unknown as Response;
      }

      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // -------------------------------------------------------------------
    // 404 for all other routes
    // -------------------------------------------------------------------
    return Response.json(
      { error: "Not Found", message: "Endpoint not found" },
      { status: 404, headers: CORS_HEADERS }
    );
  },

  /**
   * WebSocket handlers — Bun uses centralized handlers for all connections.
   * Per-connection state is stored in ws.data (set during upgrade).
   */
  websocket: {
    /**
     * Called when a client WebSocket connection is established.
     * Opens the upstream Deepgram Flux connection and wires bidirectional forwarding.
     */
    async open(ws) {
      console.log("Client connected to /api/flux");
      activeConnections.add(ws);

      const url = new URL(ws.data.url, "http://localhost");
      const queryParams = url.searchParams;

      // Build the Flux (listen.v2) connection options from client parameters
      const options = buildFluxOptions(queryParams);

      console.log(
        `Connecting to Deepgram Flux: model=flux-general-en, encoding=${options.encoding}, sample_rate=${options.sample_rate}`
      );

      // Create the Deepgram Flux connection object via the SDK (not yet connected).
      let dgConn: any;
      try {
        dgConn = await deepgram.listen.v2.createConnection(options);
      } catch (error) {
        console.error("Failed to create Deepgram Flux connection:", error);
        try {
          ws.close(1011, "Failed to reach Deepgram");
        } catch {
          // Client may already be closed
        }
        activeConnections.delete(ws);
        return;
      }
      ws.data.dgConn = dgConn;

      // Handle Deepgram connection open
      dgConn.on("open", () => {
        console.log("Connected to Deepgram Flux API");
      });

      // Deepgram -> browser. Flux messages are JSON (Connected / TurnInfo /
      // EagerEndOfTurn / TurnResumed / FatalError / ...). The SDK delivers
      // parsed objects; forward as-is if it ever hands back a raw string to
      // avoid double-encoding.
      dgConn.on("message", (data: unknown) => {
        ws.data.deepgramMessageCount++;
        if (ws.data.deepgramMessageCount % 10 === 0) {
          console.log(
            `<- Deepgram message #${ws.data.deepgramMessageCount} (type: ${(data as any)?.type})`
          );
        }
        try {
          ws.send(typeof data === "string" ? data : JSON.stringify(data));
        } catch {
          // Client may have disconnected
        }
      });

      // Handle Deepgram errors
      dgConn.on("error", (error: unknown) => {
        console.error("Deepgram socket error:", error);
        try {
          ws.close(1011, "Deepgram connection error");
        } catch {
          // Client may already be closed
        }
      });

      // Handle Deepgram connection close
      dgConn.on("close", () => {
        console.log("Deepgram connection closed");
        try {
          ws.close(1000, "Deepgram connection closed");
        } catch {
          // Client may already be closed
        }
      });

      // Open the connection and flush anything the browser sent early.
      try {
        dgConn.connect();
        await dgConn.waitForOpen();
        ws.data.dgReady = true;
        for (const item of ws.data.pending) {
          try {
            if (item.binary) {
              dgConn.sendMedia(item.data);
            } else if (item.data?.type === "CloseStream") {
              dgConn.sendCloseStream({ type: "CloseStream" });
            }
          } catch (error) {
            console.error("Failed to flush buffered frame to Deepgram:", error);
          }
        }
        ws.data.pending = [];
      } catch (error) {
        console.error("Deepgram connection did not open:", error);
        try {
          ws.close(1011, "Deepgram connection failed to open");
        } catch {
          // Client may already be closed
        }
      }
    },

    /**
     * Called when a message arrives from the client.
     * Forwards the message to Deepgram.
     */
    message(ws, message) {
      ws.data.clientMessageCount++;
      const isBinary = typeof message !== "string";
      if (ws.data.clientMessageCount % 100 === 0 || !isBinary) {
        const size =
          typeof message === "string"
            ? message.length
            : message.byteLength;
        console.log(
          `-> Client message #${ws.data.clientMessageCount} (binary: ${isBinary}, size: ${size})`
        );
      }

      const dgConn = ws.data.dgConn;

      // Binary frames are audio — stream them to Deepgram via sendMedia.
      if (isBinary) {
        if (!ws.data.dgReady) {
          ws.data.pending.push({ binary: true, data: message });
          return;
        }
        try {
          dgConn?.sendMedia(message);
        } catch (error) {
          console.error("Failed to send audio to Deepgram:", error);
        }
        return;
      }

      // Text frame — a JSON control message. Flux v2 only exposes CloseStream
      // as a client control message; other types are ignored.
      let msg: any;
      try {
        msg = JSON.parse(message as string);
      } catch {
        console.warn("Ignoring non-JSON text message from client");
        return;
      }
      if (!ws.data.dgReady) {
        ws.data.pending.push({ binary: false, data: msg });
        return;
      }
      try {
        if (msg?.type === "CloseStream") {
          dgConn?.sendCloseStream({ type: "CloseStream" });
        } else {
          console.warn("Ignoring unknown client control message type:", msg?.type);
        }
      } catch (error) {
        console.error("Failed to forward control message to Deepgram:", error);
      }
    },

    /**
     * Called when the client WebSocket connection closes.
     * Closes the upstream Deepgram connection.
     */
    close(ws, code, reason) {
      console.log(`Client disconnected: ${code} ${reason}`);
      activeConnections.delete(ws);
      try {
        ws.data.dgConn?.close();
      } catch {
        // already closed
      }
    },
  },
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

/**
 * Graceful shutdown handler
 */
function gracefulShutdown(signal: string) {
  console.log(`\n${signal} signal received: starting graceful shutdown...`);

  // Close all active WebSocket connections
  console.log(
    `Closing ${activeConnections.size} active WebSocket connection(s)...`
  );
  for (const ws of activeConnections) {
    try {
      ws.close(1001, "Server shutting down");
    } catch {
      // Ignore errors during shutdown
    }
  }

  // Stop the server
  server.stop();
  console.log("Server stopped");
  console.log("Shutdown complete");
  process.exit(0);
}

// Handle shutdown signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  gracefulShutdown("UNCAUGHT_EXCEPTION");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  gracefulShutdown("UNHANDLED_REJECTION");
});

// ============================================================================
// STARTUP BANNER
// ============================================================================

console.log("\n" + "=".repeat(70));
console.log(`Backend API Server running at http://localhost:${CONFIG.port}`);
console.log("");
console.log(`GET  /api/session`);
console.log(`WS   /api/flux (auth required)`);
console.log(`GET  /api/metadata`);
console.log(`GET  /health`);
console.log("=".repeat(70) + "\n");
