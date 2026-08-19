#!/usr/bin/env python3
"""Loopback TCP server that keeps accepted connections open for concurrency tests."""

from __future__ import annotations

import argparse
import asyncio


async def hold_connection(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    try:
        while await reader.read(65536):
            pass
    finally:
        writer.close()
        await writer.wait_closed()


async def run(port: int) -> None:
    server = await asyncio.start_server(hold_connection, "127.0.0.1", port)
    print(f"READY {port}", flush=True)
    async with server:
        await server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    asyncio.run(run(args.port))


if __name__ == "__main__":
    main()
