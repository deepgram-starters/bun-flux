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
