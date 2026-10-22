#!/usr/bin/env python3
"""Portable launcher (NT Site Mirror v1.3 layout)."""
from pathlib import Path
import runpy
import sys

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "_ntsm" / "serve.py"
sys.argv = [str(SERVER), str(ROOT), "--contract", str(ROOT / "serve-contract.json")] + sys.argv[1:]
runpy.run_path(str(SERVER), run_name="__main__")
