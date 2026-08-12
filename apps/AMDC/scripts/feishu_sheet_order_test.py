import contextlib
import errno
import sys
import types
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "amdc_feishu_sync.py"
SPEC = importlib.util.spec_from_file_location("amdc_feishu_sync_under_test", MODULE_PATH)
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)

sheets = [
    {"sheet_id": "1", "title": "20260420"},
    {"sheet_id": "2", "title": "说明"},
    {"sheet_id": "3", "title": "20260413"},
    {"sheet_id": "4", "title": "20260316"},
    {"sheet_id": "5", "title": "20260427"},
    {"sheet_id": "6", "title": "统计"},
    {"sheet_id": "7", "title": "20260223"},
]
def cli(args, **_kwargs):
    if args[0] == "+workbook-info":
        return {"data": {"sheets": [dict(sheet) for sheet in sheets]}}
    if args[0] == "+sheet-move":
        sheet_id = args[args.index("--sheet-id") + 1]
        source_index = int(args[args.index("--source-index") + 1])
        target_index = int(args[args.index("--index") + 1])
        assert sheets[source_index]["sheet_id"] == sheet_id
        sheets.insert(target_index, sheets.pop(source_index))
        return {"data": {}}
    raise AssertionError(args)

sync.cli = cli
real_sheet_order_lock = sync.sheet_order_lock
sync.sheet_order_lock = lambda _url: contextlib.nullcontext()
try:
    order = sync.sort_workbook_date_sheets(["--url", "test-url"])
finally:
    sync.sheet_order_lock = real_sheet_order_lock
expected = ["20260427", "20260420", "20260413", "20260316", "20260223", "说明", "统计"]
actual = [sheet["title"] for sheet in sheets]
assert order == expected
assert actual == expected
source = MODULE_PATH.read_text(encoding="utf-8")
start = source.index("if not created and report_columns_match")
end = source.index("            return", start)
branch = source[start:end]
assert "sheet_order = sort_workbook_date_sheets(url_args)" in branch
assert "'sheetOrder': sheet_order" in branch
assert "transaction_result('cleanup-temporary', '', '', removedSheets=removed, removedCount=len(removed), sheetOrder=sheet_order)" in source
assert "transaction_result('rollback', target_name, backup_name, restored=True, sheetOrder=sheet_order)" in source

lock_modes = []
lock_attempts = 0

def fake_locking(_fd, mode, _size):
    global lock_attempts
    lock_modes.append(mode)
    if mode == 1:
        lock_attempts += 1
        if lock_attempts < 3:
            raise OSError(errno.EDEADLK, 'Resource deadlock avoided')

fake_msvcrt = types.SimpleNamespace(LK_NBLCK=1, LK_UNLCK=2, locking=fake_locking)
original_msvcrt = sys.modules.get('msvcrt')
original_os_name = sync.os.name
original_sleep = sync.time.sleep
try:
    sys.modules['msvcrt'] = fake_msvcrt
    sync.os.name = 'nt'
    sync.time.sleep = lambda _seconds: None
    with sync.sheet_order_lock('retry-test-url', timeout_seconds=1):
        pass
finally:
    sync.os.name = original_os_name
    sync.time.sleep = original_sleep
    if original_msvcrt is None:
        del sys.modules['msvcrt']
    else:
        sys.modules['msvcrt'] = original_msvcrt
assert lock_modes == [1, 1, 1, 2]
assert 'msvcrt.LK_NBLCK' in source
assert 'Timed out waiting for the Feishu workbook sheet-order lock' in source
print("feishu sheet order behavior ok")
