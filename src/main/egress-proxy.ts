// A local proxy that only reaches allowed hosts. It is the backstop for traffic that webRequest does not
// see: raw CDP requests and, measured in e2e/security.ts, WebTransport, which does not leave once it is set.
import { lookup as dnsLookup } from "node:dns";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type LookupFunction, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isNonPublicAddress, type EgressAllowlist } from "../egress";

const stripBrackets = (host: string) => host.replace(/^\[|\]$/g, "");

export interface ProxyOptions {
  /** Maps fixture hosts to loopback in tests. A mapped host skips the address check. The app does not set this. */
  connectHost?: (host: string) => string;
  /** Replaces DNS in tests, so a name can pretend to resolve to a local address. */
  lookup?: LookupFunction;
}

export class EgressProxy {
  private readonly server: Server;
  private readonly sockets = new Set<Duplex>();
  /** Long-lived connections and their hosts, which must not outlive the permission that opened them. */
  private readonly connections = new Map<Duplex, string>();

  /** Refuses names that resolve to a local address, so DNS rebinding cannot turn a public name into a local one. */
  private readonly publicOnly: LookupFunction = (hostname, options, callback) => {
    (this.options.lookup ?? dnsLookup)(hostname, options, (error: NodeJS.ErrnoException | null, address: any, family?: number) => {
      if (error) return callback(error, address, family);
      const refused = () => callback(Object.assign(new Error(`${hostname} resolves to a local address`), { code: "EACCES" }), address, family);
      if (Array.isArray(address)) {
        const allowed = address.filter((entry) => !isNonPublicAddress(entry.address));
        return allowed.length ? callback(null, allowed as any, family) : refused();
      }
      return isNonPublicAddress(address) ? refused() : callback(null, address, family);
    });
  };

  constructor(
    private readonly allowlist: EgressAllowlist,
    private readonly options: ProxyOptions = {},
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

  /** Where to connect for a host. Hosts login opened only reach public addresses. */
  private route(host: string): { host: string; lookup?: LookupFunction } {
    const mapped = this.options.connectHost?.(host);
    if (mapped !== undefined && mapped !== host) return { host: stripBrackets(mapped) };
    const bare = stripBrackets(host);
    if (!this.allowlist.trustsLocalAddresses(host)) return { host: bare, lookup: this.publicOnly };
    return { host: bare, ...(this.options.lookup ? { lookup: this.options.lookup } : {}) };
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
    if (url.protocol !== "http:" || !this.allowlist.admits(url.hostname)) {
      res.writeHead(403).end();
      return;
    }
    const { "proxy-connection": _proxyConnection, ...headers } = req.headers;
    this.connections.set(req.socket, url.hostname);
    res.once("close", () => this.connections.delete(req.socket));
    const upstream = request(
      { ...this.route(url.hostname), port: url.port || 80, path: url.pathname + url.search, method: req.method, headers },
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
    if (!this.allowlist.admits(url.hostname)) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    this.connections.set(client, url.hostname);
    client.once("close", () => this.connections.delete(client));
    const upstream: Socket = connect({ ...this.route(url.hostname), port: Number(url.port) || 443 }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    this.track(upstream);
    upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  }

  /** A WebSocket opened during login would otherwise keep sending after the host is no longer allowed. */
  closeDisallowed(): void {
    for (const [connection, host] of this.connections) {
      if (!this.allowlist.admits(host)) connection.destroy();
    }
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
