import { expect, test } from "bun:test";
import net from "node:net";

const appRoot = new URL("..", import.meta.url).pathname;

test("caps controls buffered before the Flux socket opens", async () => {
  const upstream = net.createServer(() => {});
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const port = 18303;
  const app = Bun.spawn(["bun", "server.ts"], {
    cwd: appRoot,
    env: { ...process.env, DEEPGRAM_API_KEY: "test-key", DEEPGRAM_BASE_URL: `ws://127.0.0.1:${upstreamPort}`, PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
      await Bun.sleep(50);
    }
    const session = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json() as { token: string };
    const closeCode = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/flux`, [`access_token.${session.token}`]);
      const timeout = setTimeout(() => reject(new Error("pending queue was not capped")), 5_000);
      socket.addEventListener("open", () => {
        for (let index = 0; index <= 128; index += 1) socket.send(JSON.stringify({ type: "Configure", eot_threshold: 0.7 }));
      });
      socket.addEventListener("close", (event) => { clearTimeout(timeout); resolve(event.code); });
      socket.addEventListener("error", () => reject(new Error("browser socket failed")));
    });
    expect(closeCode).toBe(1009);
  } finally {
    app.kill();
    await app.exited;
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("forwards Flux options, media, controls, and close details", async () => {
  let upstreamUrl: URL | undefined;
  let receivedBinary = false;
  const controls: { type?: string }[] = [];
  const upstream = Bun.serve({
    port: 18306,
    fetch(request, server) {
      upstreamUrl = new URL(request.url);
      if (server.upgrade(request)) return;
      return new Response("Expected WebSocket", { status: 426 });
    },
    websocket: {
      message(socket, message) {
        if (typeof message === "string") {
          controls.push(JSON.parse(message));
        } else {
          receivedBinary = true;
        }
        if (
          receivedBinary &&
          ["Configure", "ForceEndTurn", "CloseStream"].every((type) => controls.some((control) => control.type === type))
        ) {
          socket.close(1008, "policy rejected");
        }
      },
    },
  });
  const port = 18305;
  const app = Bun.spawn(["bun", "server.ts"], {
    cwd: appRoot,
    env: { ...process.env, DEEPGRAM_API_KEY: "test-key", DEEPGRAM_BASE_URL: "ws://127.0.0.1:18306", PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
      await Bun.sleep(50);
    }
    const session = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json() as { token: string };
    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/api/flux?eot_threshold=0&eager_eot_threshold=0&eot_timeout_ms=0&keyterm=alpha&keyterm=beta`,
        [`access_token.${session.token}`]
      );
      const timeout = setTimeout(() => reject(new Error("upstream did not receive all Flux frames")), 5_000);
      socket.addEventListener("open", () => {
        socket.send(new Uint8Array([1, 2, 3]));
        socket.send(JSON.stringify({ type: "Configure", eot_threshold: 0 }));
        socket.send(JSON.stringify({ type: "ForceEndTurn" }));
        socket.send(JSON.stringify({ type: "CloseStream" }));
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timeout);
        resolve({ code: event.code, reason: event.reason });
      });
      socket.addEventListener("error", () => reject(new Error("browser socket failed")));
    });

    expect(upstreamUrl?.pathname).toBe("/v2/listen");
    expect(upstreamUrl?.searchParams.get("eot_threshold")).toBe("0");
    expect(upstreamUrl?.searchParams.get("eager_eot_threshold")).toBe("0");
    expect(upstreamUrl?.searchParams.get("eot_timeout_ms")).toBe("0");
    expect(upstreamUrl?.searchParams.getAll("keyterm")).toEqual(["alpha", "beta"]);
    expect(receivedBinary).toBe(true);
    expect(controls.map((control) => control.type)).toEqual(["Configure", "ForceEndTurn", "CloseStream"]);
    expect(closed).toEqual({ code: 1008, reason: "policy rejected" });
  } finally {
    app.kill();
    await app.exited;
    upstream.stop();
  }
});
