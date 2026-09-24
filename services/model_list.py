"""
模型列表服务
支持动态API获取和预定义模型列表
"""
import httpx
from typing import Dict, List

# 导入统一的日志前缀
try:
    from ..utils.common import ERROR_PREFIX
except ImportError:
    # 如果导入失败,使用默认值
    ERROR_PREFIX = "✨-错误"

# --- 智谱AI预定义模型列表 ---
ZHIPU_MODELS = [
    "glm-5.1",
    "glm-5",
    "glm-5-turbo",
    "glm-5v-turbo",
    "glm-4.7",
    "glm-4.7-flash",
    "glm-4.7-flashx",
    "glm-4.6",
    "glm-4.6v",
    "glm-4.6v-flash",
    "glm-4.5",
    "glm-4.5-flash",
    "glm-4.5-air",
    "glm-4.5-airx",
    "glm-4.5v",
    "glm-4-plus",
    "glm-4-flash",
    "glm-4-flash-250414",
    "glm-4-air",
    "glm-4-air-250414",
    "glm-z1-flash",
    "glm-4v-plus",
    "glm-4v-flash",
    "glm-4v",
    "glm-ocr",
    "glm-4-long",
    "glm-4-longwriter",
    "glm-zero-preview",
    "glm-4.1v-thinking-flash"
]

def get_models_from_service(base_url: str, api_key: str, service_type: str) -> Dict:

    """
    从服务提供商动态获取模型列表
    
    参数:
        base_url: API基础URL
        api_key: API密钥
        service_type: 服务类型 ('openai_compatible', 'ollama', 'zhipu', 'codex_cli')
    
    返回:
        Dict: {
            "success": bool,
            "models": {"llm": [...], "vlm": [...]},  # success=True时
            "error": str  # success=False时的错误信息
        }
    """
    try:
        if service_type == 'codex_cli':
            return {"success": True, "models": {"llm": ["default"], "vlm": []}}

        # 检查必需参数
        if not base_url:
            return {
                "success": False,
                "error": "请填写Base URL"
            }
        
        # 智谱使用预定义列表,不需要API Key验证
        if service_type == 'zhipu':
            return _get_zhipu_models()
        
        if service_type == 'openai_compatible' and not api_key:
            return {
                "success": False,
                "error": "请填写API Key"
            }
        
        # 根据服务类型调用不同的获取方法
        if service_type == 'ollama':
            return _fetch_ollama_models(base_url)
        else:  # openai_compatible
            return _fetch_openai_compatible_models(base_url, api_key)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} 获取模型列表异常: {str(e)}")
        return {
            "success": False,
            "error": f"获取失败: {str(e)}"
        }


def _fetch_openai_compatible_models(base_url: str, api_key: str) -> Dict:
    """获取OpenAI兼容API的模型列表"""
    try:
        url = f"{base_url.rstrip('/')}/models"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json"
        }
        
        response = httpx.get(url, headers=headers, timeout=10.0)
        
        if response.status_code == 401:
            return {
                "success": False,
                "error": "API Key错误,认证失败"
            }
        elif response.status_code == 404:
            return {
                "success": False,
                "error": "API地址错误,未找到模型接口"
            }
        elif response.status_code != 200:
            return {
                "success": False,
                "error": f"API返回错误 (HTTP {response.status_code})"
            }
        
        data = response.json()
        models = data.get('data', [])
        
        if not models:
            return {
                "success": False,
                "error": "未找到任何可用模型"
            }
        
        # 提取模型ID并返回(LLM和VLM返回相同列表)
        model_ids = [m['id'] for m in models if 'id' in m]
        
        return {
            "success": True,
            "models": {
                "llm": model_ids.copy(),
                "vlm": model_ids.copy()
            }
        }
        
    except httpx.TimeoutException:
        return {
            "success": False,
            "error": "请求超时,请检查网络连接"
        }
    except httpx.ConnectError:
        return {
            "success": False,
            "error": "无法连接到服务,请检查Base URL"
        }
    except Exception as e:
        print(f"{ERROR_PREFIX} 获取OpenAI兼容模型失败: {str(e)}")
        return {
            "success": False,
            "error": f"获取模型列表失败: {str(e)}"
        }


def _fetch_ollama_models(base_url: str) -> Dict:
    """获取Ollama的模型列表"""
    try:
        # Ollama 原生 API 在根路径,需要移除可能存在的 /v1 后缀
        clean_url = base_url.rstrip('/')
        if clean_url.endswith('/v1'):
            clean_url = clean_url[:-3]
        
        url = f"{clean_url}/api/tags"
        
        # 添加必需的请求头(参考 ollama-python SDK)
        import platform
        headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': f'comfyui-prompt-assistant/1.0 ({platform.machine()} {platform.system().lower()}) Python/{platform.python_version()}'
        }
        
        # 创建禁用代理的客户端，避免系统代理干扰localhost请求
        # 这是502错误的常见原因：系统代理无法正确转发localhost请求
        with httpx.Client(proxy=None, trust_env=False) as client:
            response = client.get(url, headers=headers, timeout=10.0)
        
        if response.status_code == 404:
            return {
                "success": False,
                "error": "Ollama服务未启动或Base URL错误"
            }
        elif response.status_code == 400:
            error_detail = response.text[:500] if response.text else "无响应体"
            return {
                "success": False,
                "error": f"Ollama返回400错误。详情: {error_detail}"
            }
        elif response.status_code == 502:
            return {
                "success": False,
                "error": f"Ollama返回错误 (HTTP 502): 网关错误，请检查Ollama服务是否正常运行"
            }
        elif response.status_code != 200:
            return {
                "success": False,
                "error": f"Ollama返回错误 (HTTP {response.status_code}): {response.text[:200]}"
            }
        
        data = response.json()
        models = data.get('models', [])
        
        if not models:
            return {
                "success": False,
                "error": "未找到任何Ollama模型"
            }
        
        # 提取模型名称并返回(LLM和VLM返回相同列表)
        model_names = [m['name'] for m in models if 'name' in m]
        
        return {
            "success": True,
            "models": {
                "llm": model_names.copy(),
                "vlm": model_names.copy()
            }
        }
        
    except httpx.TimeoutException:
        return {
            "success": False,
            "error": "请求超时,Ollama可能未启动"
        }
    except httpx.ConnectError as e:
        print(f"{ERROR_PREFIX} 无法连接到Ollama服务: {str(e)}")
        return {
            "success": False,
            "error": "无法连接到Ollama服务"
        }
    except Exception as e:
        print(f"{ERROR_PREFIX} 获取Ollama模型失败: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "error": f"获取Ollama模型失败: {str(e)}"
        }


def _get_zhipu_models() -> Dict:
    """
    获取智谱AI的预定义模型列表
    智谱AI暂不提供公开的模型列表API,使用预定义列表
    """
    return {
        "success": True,
        "models": {
            "llm": ZHIPU_MODELS.copy(),
            "vlm": ZHIPU_MODELS.copy()
        }
    }


