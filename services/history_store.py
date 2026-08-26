"""
服务端历史记录持久化存储
=========================

将前端 localStorage 中的历史记录持久化到插件配置目录的 JSON 文件中，
避免浏览器清理缓存 / 插件初始化异常导致历史数据丢失。

设计说明：
- 数据量小（前端已限制全局最多 100 条、单条内容最长 5000 字符），
  因此采用「整体读 + 整体写」的全量 JSON 文件模型，与前端
  HistoryCacheService.saveAllHistory() 的全量覆盖语义保持一致。
- 写入使用「临时文件 + os.replace」原子替换，避免写一半崩溃导致文件损坏。
- 使用线程锁保证并发安全（aiohttp 多 worker 场景）。
- 文件损坏时自动保留现场（重命名为 .corrupted）并返回空数据，不影响启动。
"""

import json
import os
import threading

# 插件配置目录（config/），与 tags_user.json 等用户数据放一起
_CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config")

# 历史记录存储文件路径（运行期数据，不纳入版本管理）
HISTORY_FILE = os.path.join(_CONFIG_DIR, "history_cache.json")

# 上限保护（与前端限制对齐并放宽，防止异常数据把文件撑爆）
MAX_HISTORY_ITEMS = 5000
MAX_ITEM_CONTENT_LEN = 20000

_lock = threading.Lock()


def _validate_history(data):
    """校验并规整历史数据：必须是对象数组，超限字段截断/丢弃。"""
    if not isinstance(data, list):
        raise ValueError("history data must be a list")

    if len(data) > MAX_HISTORY_ITEMS:
        data = data[:MAX_HISTORY_ITEMS]

    cleaned = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            content = item.get("content")
            if isinstance(content, str) and len(content) > MAX_ITEM_CONTENT_LEN:
                item = dict(item)
                item["content"] = content[:MAX_ITEM_CONTENT_LEN]
            cleaned.append(item)
        except Exception:
            continue
    return cleaned


def load_history():
    """读取历史记录；文件不存在返回空列表，文件损坏时保留现场并返回空列表。"""
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
        return []
    except FileNotFoundError:
        return []
    except Exception:
        # 文件损坏：保留现场便于排查，不阻断插件启动
        try:
            if os.path.exists(HISTORY_FILE):
                os.replace(HISTORY_FILE, HISTORY_FILE + ".corrupted")
        except Exception:
            pass
        return []


def save_history(data):
    """全量保存历史记录（原子写入 + 线程锁），返回实际保存的条数。"""
    data = _validate_history(data)
    with _lock:
        os.makedirs(_CONFIG_DIR, exist_ok=True)
        tmp_path = HISTORY_FILE + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp_path, HISTORY_FILE)
        return len(data)
