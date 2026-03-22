from __future__ import annotations

import argparse
import os

from apps.shared.cli import env_int
from launcher_server import run_doctor_app


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run doctor UI only.")
    parser.add_argument("--host", default=os.getenv("MYOPIA_DOCTOR_HOST") or "0.0.0.0")
    parser.add_argument("--port", type=int, default=env_int("MYOPIA_DOCTOR_PORT", 8787))
    parser.add_argument("--backend-host", default=os.getenv("MYOPIA_API_HOST") or "127.0.0.1")
    parser.add_argument("--backend-port", type=int, default=env_int("MYOPIA_API_PORT", 8000))
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return run_doctor_app(
        host=args.host,
        port=args.port,
        backend_host=args.backend_host,
        backend_port=args.backend_port,
    )


if __name__ == "__main__":
    raise SystemExit(main())

