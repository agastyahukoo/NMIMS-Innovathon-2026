# Crypto Terminal

<p align="center">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-Desktop-47848F?logo=electron&logoColor=white">
  <img alt="Flask" src="https://img.shields.io/badge/Flask-Backend-000000?logo=flask&logoColor=white">
  <img alt="Ollama" src="https://img.shields.io/badge/Ollama-Local%20LLM-111111">
  <img alt="Binance" src="https://img.shields.io/badge/Binance-Market%20Data-F3BA2F?logo=binance&logoColor=black">
  <img alt="Reddit" src="https://img.shields.io/badge/Reddit-Sentiment-FF4500?logo=reddit&logoColor=white">
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-Local%20Storage-003B57?logo=sqlite&logoColor=white">
  <img alt="Prophet" src="https://img.shields.io/badge/Prophet-ML%20Evaluation-2F6FED">
</p>

## Specifications

| Item | Value |
|---|---|
| Type | Self-hosted LLM crypto intelligence terminal |
| Event | NMIMS Innovathon 2026 |
| Platform | Electron desktop application |
| Backend | Flask API |
| Inference | Ollama |
| Storage | SQLite |
| Data Sources | Binance, Reddit |
| Forecasting | Technical signals, Prophet-based evaluation |

## Features

- Live market data for any Binance-supported trading pair
- Live candlestick charting with configurable timeframes
- Local LLM inference through Ollama
- Support for any locally available Ollama model
- Support for custom Ollama models and local model switching
- Validated support up to `deepseek-r1:671b`
- Reddit sentiment ingestion by coin, keyword, or custom subreddit
- LLM-based sentiment classification and summary generation
- Technical indicator-based directional signals
- Prophet-based ML evaluation and cached model usage
- Signal generation with history and explainability fields
- Backtesting and analytics views
- Local SQLite persistence
- Desktop settings and runtime controls

## Supported Inputs

| Category | Support |
|---|---|
| Coins / Pairs | Any Binance-supported symbol |
| Timeframes | User-selectable |
| LLM Models | Any installed Ollama model |
| Custom Models | Supported |
| Reddit Sources | Default and custom subreddits |

## Stack

| Layer | Technologies |
|---|---|
| Frontend | Electron, HTML, CSS, JavaScript, lightweight-charts |
| Backend | Python, Flask, Flask-CORS, Requests |
| Data / Storage | SQLite, NumPy |
| ML / Forecasting | Prophet, pandas |
| Local AI Runtime | Ollama |

## Project Structure

```text
.
├── backend/
│   ├── app.py
│   ├── app.db
│   └── requirements.txt
├── desktop/
│   ├── main.js
│   ├── preload.js
│   ├── renderer.js
│   ├── index.html
│   ├── styles.css
│   ├── analytics.html
│   ├── analytics.css
│   ├── analytics.js
│   ├── splash.html
│   ├── splash.css
│   └── splash.js
├── package.json
├── start.sh
└── README.md