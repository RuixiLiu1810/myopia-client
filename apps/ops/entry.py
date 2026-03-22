from __future__ import annotations

import argparse
import os

from apps.shared.cli import env_int
from launcher_server import run_ops_dashboard


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run ops dashboard UI only (process control disabled by default)."
    )
    parser.add_argument("--host", default=os.getenv("MYOPIA_OPS_HOST") or "0.0.0.0")
    parser.add_argument("--port", type=int, default=env_int("MYOPIA_OPS_PORT", 8788))
    parser.add_argument("--backend-host", default=os.getenv("MYOPIA_API_HOST") or "127.0.0.1")
    parser.add_argument("--backend-port", type=int, default=env_int("MYOPIA_API_PORT", 8000))
    parser.add_argument(
        "--allow-process-control",
        action="store_true",
        help="Allow ops web to start/stop backend process (development only).",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return run_ops_dashboard(
        host=args.host,
        port=args.port,
        backend_host=args.backend_host,
        backend_port=args.backend_port,
        allow_process_control=bool(args.allow_process_control),
    )


if __name__ == "__main__":
    raise SystemExit(main())
