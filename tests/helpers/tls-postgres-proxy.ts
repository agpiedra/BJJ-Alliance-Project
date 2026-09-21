import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

/** Test-only certificates generated once (tests/helpers/tls/README.md). */
export function tlsFixture(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), "tests", "helpers", "tls", name), "utf8");
}

const SSL_REQUEST_CODE = 80877103;

/**
 * A TLS front for a real, plaintext Postgres — so CI (whose Postgres has no
 * TLS) can exercise the app's real TLS configuration end to end.
 *
 * Speaks just enough of the Postgres wire protocol: it answers the client's
 * `SSLRequest` with `S`, upgrades the socket to TLS with the chosen fixture
 * certificate, then pipes the decrypted bytes to the real database.
 * Anything that doesn't open with an `SSLRequest` is dropped — every test
 * here asserts on the encrypted path.
 *
 * `serverCert` picks which fixture the "server" presents: `server-localhost`
 * names `localhost`; `server-wrongname` names only `not-localhost.example`.
 */
export async function startTlsPostgresProxy(options: {
  serverCert: "server-localhost" | "server-wrongname";
  upstream: { host: string; port: number };
}): Promise<{ port: number; close: () => Promise<void> }> {
  const cert = tlsFixture(`${options.serverCert}.crt`);
  const key = tlsFixture(`${options.serverCert}.key`);
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => {});

    client.once("data", (first) => {
      if (first.length !== 8 || first.readInt32BE(4) !== SSL_REQUEST_CODE) {
        client.destroy();
        return;
      }
      client.write("S");

      const secure = new tls.TLSSocket(client, { isServer: true, cert, key });
      const upstream = net.connect(options.upstream.port, options.upstream.host);
      sockets.add(secure);
      sockets.add(upstream);
      // A client that rejects the certificate aborts the handshake; that is the
      // outcome under test, not a proxy failure.
      secure.on("error", () => upstream.destroy());
      upstream.on("error", () => secure.destroy());
      secure.on("close", () => upstream.destroy());
      upstream.on("close", () => secure.destroy());
      secure.pipe(upstream);
      upstream.pipe(secure);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
