<div align="center">

<h1 align="center">ComfyUI Prompt Assistant ✨ Prompt Assistant V2.0</h1>

<img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/idleeyan/ComfyUI-Prompt-Assistant">
<a href="https://space.bilibili.com/520680644"><img alt="bilibili" src="https://img.shields.io/badge/Detailed Video Tutorial-blue?style=flat&logo=bilibili&logoColor=2300A5DC&labelColor=%23FFFFFF&color=%2307A3D7"></a>
<a href="https://data.xflow.cc/wechat.png"><img alt="weChat" src="https://img.shields.io/badge/Join our Community-blue?logo=wechat&logoColor=green&labelColor=%23FFFFFF&color=%2307A3D7"></a>
<a href="https://ycn58r88iss5.feishu.cn/share/base/form/shrcnJ1AzbUJCynW9qrNJ2zPugy"><img alt="bug" src="https://img.shields.io/badge/Bug-Feedback-orange"></a>

</div>

<div align="center">

[简体中文](README.md) | [English](README.en.md)

</div>

<h4 align="center">🎉🎉 A brand new version of Prompt Assistant is online! Stronger functions, faster response! Optimized for ComfyUI Node 2.0! 🎉🎉</h4>

> Supports cloud-based LLM APIs and local Ollama models. Provides translation for prompt nodes, Markdown nodes, and node documentation; features prompt enhancement, image/video captioning, common tag collection, and history logs. An all-in-one prompt assistant plugin!

## **📣 Updates**

<details open>
<summary><strong>[2026-10-30] 🔧 Fork Fixes</strong></summary>

**Fixes:**
* **Rules Manager Display Issues**: Fixed the rules manager dialog appearing transparent/borderless and being unclickable on newer ComfyUI frontends (comfyui-frontend-package 1.5x+). Restored the `--p-*` theme variables that the new frontend no longer injects; made the dialog and its inner floating layers follow a responsive base size and z-index; floating layers now mount into the currently open dialog container so they are no longer blocked by the modal layer (`pointer-events: none`).

</details>

<details>
<summary><strong>[2026-04-21] 🔥 V2.0.6</strong></summary>

**Changes:**
* **V3 Architecture Upgrade**: Fully refactored node backend to align with ComfyUI V3 API standards for enhanced stability and performance.

**Fixes:**
* **Ollama Request Optimization & Fixes**: Optimized Ollama request logic with smart routing (`base_url` without `/v1` uses Native API, with `/v1` uses OpenAI-compatible API). Fixed crashes where certain models returned empty content due to streaming filter logic issues.
* **Subgraph Mounting Optimization**: Fixed assistant initialization and stability on Subgraph nodes across Node 2.0 (Vue) and LiteGraph modes.

</details>

<details>
<summary><strong>V2.0.5</strong></summary>

**Changes:**

* **Node Random Seed**: Added a unified random seed widget to all nodes to handle repetitive execution, replacing the old "[R]" trigger keyword mechanism.
  
* **Enhanced Frontend UI Multi-language Support**: Special thanks to @rafek1241. Added ui-i18n functionality, supporting (Chinese, English, Japanese, Korean, French, Spanish, Russian, German, etc.).

**Fixes:**
* **Node Width Locked**: Fixed an issue where node width could not be adjusted in Node 2.0.

* **Greying Out Native Service `baseUrl`**: Prevented accidental modification of built-in service URLs to avoid request failures.

* **Network Exception Errors**: Fixed a network exception bug for proxy-based (e.g., xflow) requests caused by forced direct-connection logic.
* **Image Node ✨ Icon Moved**: Moved the icon to the right side to prevent overlap with node IDs in Node 2.0.

</details>

<details>
<summary><strong>V2.0.4</strong></summary>

* **Bug Fixes**: Fixed issues where tag and history functions were unavailable.

</details>

<details>
<summary><strong>V2.0.3</strong></summary>

* **Assistant UI**: Fixed instability of the assistant creator in subgraphs and cases where creators failed to appear when image nodes lacked images.
  
* **Ollama**: Fixed HTTP 502 errors caused by proxy settings.

</details>

<details>
<summary><strong>V2.0.2</strong></summary>

* **Tag Module**: Fixed formatting issues; users can now freely create categories and manage tags. Fixed preset creation and migration errors.
  
* **Assistant UI**: Optimized mounting methods in Node 2.0, fixed subgraph stability issues, and improved performance.
  
* **Interaction**: Added streaming input effects and refined UI details.
  
* **Translation**: Added mixed-language translation rule parameters (default to Chinese/English) and improved node doc translation.
  
* **Built-in Rules**: Fixed issues with mixed Chinese/English output and missing Kontext translations.
  
* **API Requests**: Fixed Gemini-1.5-Pro request issues and Ollama 404 errors.
  
* **Node Optimization**: Improved the Video Caption node.
  
* **Console Logs**: Optimized logs and fixed a infinite loop bug in progress logs.
  
* **Dependencies**: Prevented boot failures due to missing dependencies.

</details>

<details>
<summary><strong>V2.0.0</strong></summary>

* **Core Refactoring**: Completely rebuilt the assistant for better stability and response speed via API/Ollama.
  
* **UI Refresh**: Rebuilt frontend components for better stability and **Node 2.0** support, including customizable positions and button sorting.
  
* **Tag Module**: New CSV-based tag mechanism with on-the-fly switching and collection features.
* **Rule Module**: New configuration window supporting categories and custom rule displays; many built-in rules added.
* **API Service**: New API configuration UI with custom service support and multiple model fallback options. Independent service selection for enhancement, translation, and captioning.
* **Node Overhaul**: All nodes rebuilt with multi-language support. Added Video Caption node (**Beta**).
* **Migration**: User configs moved to `\user\default\prompt-assistant` to prevent data loss during reinstalls.
* **New Features**: Node doc translation and Markdown node translation.

</details>

<details>
<summary><strong>V1.x.x</strong></summary>

<details>
<summary><strong>V1.2.x </strong></summary>

<details>
<summary>[2025-11-12] V1.2.3 </summary>

* Fixed empty results for Ollama and custom services.
* Switched Ollama to native interface for better Qwen2-VL support.
* Added HTTP API fallback for better stability.

</details>

<details>
<summary>[2025-10-14] V1.2.2 </summary>

* Dropped support for ComfyUI < 0.3.27 to prevent UI issues.
* Fixed errors when using 302.AI and issues with Ollama auto-unload.
* Added independent Ollama unload options to all nodes.
* Removed forced direct-connection for LLM/VLM to avoid request errors; added a setting toggle for direct-connection.
* Optimized console log formatting.

</details>

<details>
<summary>[2025-10-14] V1.2.1 </summary>

* Improved UI responsiveness.
* Enhanced API request retry mechanism.
* Added settings for auto-removing redundant spaces, dots, and punctuation conversion.
* Tag window now remembers size, category, and scroll position.
* API config UI now supports auto-fetching model lists.
* Ollama auto-vram-unload option added.
* Fixed a bug where helpers weren't created for every textbox in list views.

</details>

<details>
<summary>[2025-09-16] V1.2.0 </summary>

* Added Prompt Expand node.
* Added 302.AI and Ollama service support.
* Tag panel memory feature added.
* Right-click menu for quick service switching.
* Support for disabling CoT (Chain of Thought) for mainstream models.
* Optimized caption and translation nodes.
* Added community feedback badge.
* Fixed various UI and request bugs.

</details>
</details>
<details>
<summary><strong>V1.1.x </strong></summary>

<details>
<summary>[2025-08-28] V1.1.3 </summary>

* Optimized Assistant UI to automatically avoid scrollbars and prevent overlapping accidental triggers.
* Fixed an issue where the tag popup lacked a scrollbar, causing incomplete content display.

</details>

<details>
<summary>[2025-08-23] V1.1.2 </summary>

* Refactored nodes to resolve multiple queues and duplicate execution issues during runtime.
* Added model parameters to the API config interface; some errors can be resolved by adjusting the max token count.
* Simplified image captioning workflow to improve captioning speed.
* Fixed an issue where unloaded tags couldn't be searched during on-demand loading.

</details>

<details>
<summary>[2025-08-10] V1.1.1 </summary>

* Fixed image caption node errors.

</details>

<details>
<summary>[2025-08-10] V1.1.0 </summary>

* Modified UI interactions.
* Supported all OpenAI SDK compatible APIs.
* Added custom rules.
* Added custom tags.
* Added Image Caption, Kontext Preset, and Translation nodes.

</details>

</details>

<details>
<summary><strong>V1.0.x</strong> </summary>

<details>
<summary>[2025-06-24] V1.0.6</summary>

* Fixed some UI bugs.

</details>

<details>
<summary>[2025-06-24] V1.0.5</summary>

* Fixed assistant UI anomaly when creating a kontext node using the selection toolbar.
* Fixed Zhipu service unavailability likely caused by network conditions.
* Fixed workflow loading failures caused by instance clearing errors.
* Fixed an issue where the AIGODLIKE-COMFYUI-TRANSLATION plugin caused the tag popup to freeze.
* Added resizable tag panel.
* Optimized UI resource loading mechanism.

</details>

<details>
<summary>[2025-06-24] V1.0.3</summary>

* Refactored API request service to prevent API keys from being exposed to the frontend.
* Modified config save/load mechanism to fix config saving issues.
* Fixed minor bugs.

</details>

<details>
<summary>[2025-06-21] V1.0.2</summary>

* Fixed minor bugs.

</details>

<details>
<summary>[2025-06-15] V1.0.0</summary>

* One-click tag insertion.
* LLM expansion support.
* Toggle between Baidu Translate and LLM Translate.
* Image to prompt captioning.
* History, undo, and redo.

</details>

</details>
</details>

## **✨ Features**

#### 💡 Prompt Optimization + Translation
`Supports multiple preset rules (Expand, Qwen-edit, Kontext instructions, etc.)`
`No need to set target language; automatic translation between Chinese and English with caching to prevent meaning drift.`

![Translation/Expansion](https://github.com/user-attachments/assets/a37b715e-ecfd-47d6-a4b8-a0b1e6bb9fcd)

#### 🖼 Image Captioning
`Quickly caption images as prompts on image nodes. Supports Chinese/English and various styles (Natural, Tag, etc.).`

![Captioning](https://github.com/user-attachments/assets/3713ddc5-4e2e-4412-88ee-077d86f21b99)

#### 🔖 Tags, Phrase Presets & Collection
`Collect common tags, phrases, and Lora triggers for quick insertion. Supports collection, custom sorting, and multi-set switching.`

![Tag Function](https://github.com/user-attachments/assets/944173be-8167-42eb-93d9-e0c05256ccf8)

#### 🕐 History, Undo, Redo
`Sentence-based records (triggered on focus loss). Supports undo/redo and cross-node history viewing.`

![History](https://github.com/user-attachments/assets/85868b9e-1bf5-4789-9a71-97af80ef2bc8)

#### 📜 Markdown & Node Documentation Translation
`Translates Note and Markdown nodes while maintaining formatting.`

![Markdown](https://github.com/user-attachments/assets/c2ac1266-f8c1-4b27-ba41-13c5b5e5e689)
`Translates node documentation (Beta: Button appears only for nodes with English documentation).`

![Node Doc](https://github.com/user-attachments/assets/32c9a712-20c3-4b5e-b331-bfb885b7b5d4)

### 📒 Node Introduction
Category: `✨Prompt Assistant`

#### **🔹 Translation Node**
`✨Prompt Assistant → Prompt Translation`
<img width="1700" height="700" alt="Translation Node" src="https://github.com/user-attachments/assets/9dbc9fc9-1b91-43b6-822e-d598b2c8168f" />

#### **🔹 Prompt Optimization Node**
`✨Prompt Assistant → Prompt Optimization`
<img width="1700" height="911" alt="Expand Node" src="https://github.com/user-attachments/assets/ea821506-d684-4526-9119-621bb0467ddf" />

#### **🔹 Image Caption Node**
`✨Prompt Assistant → Image Caption Prompt`
`Captions images and optimizes editing instructions via visual models.`
<img width="1700" height="800" alt="Image Caption Node" src="https://github.com/user-attachments/assets/8ff3ac96-724a-48d0-8e15-23fe0b28bec1" />
<img width="1700" height="800" alt="VLM instructions" src="https://github.com/user-attachments/assets/a95dc0f4-1d46-438f-a242-4087f6e8361a" />

#### **🔹 Video Caption Node**
`✨Prompt Assistant → Video Caption Prompt`
<img width="1700" height="1080" alt="Video Caption Node" src="https://github.com/user-attachments/assets/0143096b-24d5-4308-82ff-e0a99144db0b" />
<img width="1700" height="1102" alt="Frame Picker Tool" src="https://github.com/user-attachments/assets/96c2bd08-b26c-4df1-b32c-be8e20328c97" />

## **📦 Installation**

### ⚠️ Legacy Migration Warning
`If you installed Prompt Assistant before V2.0.0, please backup the "config" folder in the plugin directory to avoid losing API keys, custom rules, and tag data!`

If you installed via **Manager**, just update. For manual installation, it is recommended to delete the old plugin folder (backup "config" first!!), place the new folder in `custom_nodes`, and restore your config files.

#### **Install via ComfyUI Manager**
Search for `Prompt Assistant` in Manager and click `Install`.

<img width="1800" height="1098" alt="Installation" src="https://github.com/user-attachments/assets/167eb467-a77d-4a37-a95b-e935ca354284" />

#### **Clone from Repository**
1. Navigate to your custom nodes folder:
   ```bash
   cd ComfyUI/custom_nodes
   ```
2. Clone the repo:
   ```bash
   git clone https://github.com/idleeyan/ComfyUI-Prompt-Assistant.git
   ```
3. Restart ComfyUI.

#### **Download Zip**
1. Download from [Releases](https://github.com/idleeyan/ComfyUI-Prompt-Assistant/releases)
2. Extract to `ComfyUI/custom_nodes`
`⚠️ Note: It is recommended to rename the folder to "prompt-assistant" for ComfyUI compatibility.`

<img width="600" height="276" alt="GitHub Installation" src="https://github.com/user-attachments/assets/99783a78-6e0b-42aa-8f9e-7146ebcef5fd" />

### Data Migration
The new version automatically upgrades and migrates API configs, custom rules, and tags. You can place the files you want to migrate in `prompt-assistant/config`. New configs are stored in `ComfyUI\user\default\prompt-assistant`.

<img width="600" height="419" alt="Migration" src="https://github.com/user-attachments/assets/90b8f90f-51df-4537-b735-ae07c3cdff7f" />

## **⚙️ Configuration**

### Configuring API Keys and Models
<img width="1593" height="1119" alt="Config Page" src="https://github.com/user-attachments/assets/ea01c0bc-fe0f-40be-991c-d7833965213a" />
<img width="1569" height="1137" alt="API Window" src="https://github.com/user-attachments/assets/9d982773-2939-480b-a691-bb89a227a9ff" />

### Service Description
You can add custom providers or use built-in ones.
`⚠️ Disclaimer: This plugin is a tool for API calls; responsibility for third-party services is independent of this plugin. User configs are stored locally.`

* **Baidu Translate (MT)**: [Baidu Translate Portal](https://fanyi-api.baidu.com/product/11)
  `Fast but average quality. May require special network handling; 5M chars free per month.`
* **Zhipu (LLM)**: [Zhipu API Portal](https://www.bigmodel.cn/invite?icode=Wz1tQAT40T9M8vwp%2F1db7nHEaazDlIZGj9HxftzTbt4%3D)
  `Fast and unlimited quota; Note: Strict censorship may return empty results.`
* **xFlow-API Aggregation**: [xFlow API Portal](https://api.xflow.cc/register?aff=Z063)
  `Aggregates various models (Gemini, Grok, ChatGPT...) with a single API key; no networking issues.`

## **🎀 Acknowledgments**
Special thanks to our community for V2.0.0 rule templates: Adan, CJL, Normandy
