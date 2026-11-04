// A local proxy that only reaches allowed hosts. It is the backstop for traffic that webRequest does not
// see: raw CDP requests and, measured in e2e/security.ts, WebTransport, which does not leave once it is set.
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { EgressAllowlist } from "../egress";

const stripBrackets = (host: string) => host.replace(/^\[|\]$/g, "");

export class EgressProxy {
  private readonly server: Server;
  private readonly sockets = new Set<Duplex>();

  constructor(
    private readonly allowlist: EgressAllowlist,
    /** Where to connect for a host. Security tests map fixture hosts to loopback here. */
    private readonly connectHost: (host: string) => string = stripBrackets,
  ) {
    this.server = createServer((req, res) => this.forward(req, res));
    this.server.on("connect", (req, client) => this.tunnel(req, client));
    this.server.on("connection", (socket) => this.track(socket));
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => this.sockets.delete(socket));
  }

  /** Plain http:// requests arrive with an absolute URL. */
  private forward(req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== "http:" || !this.allowlist.has(url.hostname)) {
      res.writeHead(403).end();
      return;
    }
    const { "proxy-connection": _proxyConnection, ...headers } = req.headers;
    const upstream = request(
      { host: this.connectHost(url.hostname), port: url.port || 80, path: url.pathname + url.search, method: req.method, headers },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.rawHeaders);
        reply.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    req.pipe(upstream);
  }

  /** https:// and ws:// go through CONNECT, so the proxy sees only the host and port. */
  private tunnel(req: IncomingMessage, client: Duplex): void {
    this.track(client);
    let url: URL;
    try {
      url = new URL(`http://${req.url}`);
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    if (!this.allowlist.has(url.hostname)) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream: Socket = connect(Number(url.port) || 443, this.connectHost(url.hostname), () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    this.track(upstream);
    upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  }

  /** Starts on a free loopback port and resolves with it. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve((this.server.address() as AddressInfo).port));
    });
  }

  close(): void {
    this.server.close();
    for (const socket of this.sockets) socket.destroy();
  }
}
