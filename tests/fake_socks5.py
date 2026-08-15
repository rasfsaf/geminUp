#!/usr/bin/env python3
"""Loopback-only authenticated SOCKS5 server used by transport integration tests."""

from __future__ import annotations

import argparse
from pathlib import Path
import select
import socket
import socketserver
import struct


def recv_exact(connection: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = connection.recv(size - len(data))
        if not chunk:
            raise ConnectionError("peer closed the connection")
        data.extend(chunk)
    return bytes(data)


class SocksHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        client: socket.socket = self.request
        client.settimeout(15)
        version, method_count = recv_exact(client, 2)
        if version != 5:
            return
        methods = recv_exact(client, method_count)
        if 2 not in methods:
            client.sendall(b"\x05\xff")
            return
        client.sendall(b"\x05\x02")

        auth_version, username_length = recv_exact(client, 2)
        username = recv_exact(client, username_length).decode("utf-8")
        password_length = recv_exact(client, 1)[0]
        password = recv_exact(client, password_length).decode("utf-8")
        if auth_version != 1 or username != self.server.username or password != self.server.password:
            client.sendall(b"\x01\x01")
            return
        client.sendall(b"\x01\x00")

        version, command, reserved, address_type = recv_exact(client, 4)
        if version != 5 or command != 1 or reserved != 0:
            client.sendall(b"\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00")
            return
        if address_type == 1:
            host = socket.inet_ntoa(recv_exact(client, 4))
        elif address_type == 3:
            host = recv_exact(client, recv_exact(client, 1)[0]).decode("idna")
        elif address_type == 4:
            host = socket.inet_ntop(socket.AF_INET6, recv_exact(client, 16))
        else:
            client.sendall(b"\x05\x08\x00\x01\x00\x00\x00\x00\x00\x00")
            return
        port = struct.unpack("!H", recv_exact(client, 2))[0]
        message = f"CONNECT {host}:{port}"
        print(message, flush=True)
        if self.server.log_path is not None:
            with self.server.log_path.open("a", encoding="utf-8") as log_file:
                log_file.write(message + "\n")

        try:
            upstream = socket.create_connection((host, port), timeout=15)
        except OSError:
            client.sendall(b"\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00")
            return
        with upstream:
            client.sendall(b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00")
            client.setblocking(False)
            upstream.setblocking(False)
            sockets = [client, upstream]
            while True:
                readable, _, exceptional = select.select(sockets, [], sockets, 15)
                if exceptional or not readable:
                    return
                for source in readable:
                    try:
                        payload = source.recv(65536)
                    except BlockingIOError:
                        continue
                    if not payload:
                        return
                    destination = upstream if source is client else client
                    destination.sendall(payload)


class ThreadedSocksServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        username: str,
        password: str,
        log_path: Path | None,
    ) -> None:
        self.username = username
        self.password = password
        self.log_path = log_path
        super().__init__(address, SocksHandler)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--username", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--log", type=Path)
    args = parser.parse_args()
    with ThreadedSocksServer(("127.0.0.1", args.port), args.username, args.password, args.log) as server:
        print(f"READY {args.port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
