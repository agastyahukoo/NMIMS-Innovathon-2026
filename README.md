# Crypto Terminal

A self-hosted crypto intelligence terminal built for **NMIMS Innovathon 2026**, it's a **Self-Hosted LLM Crypto Sentiment & Price Prediction Terminal**. The app combines market data, Reddit sentiment, local LLM analysis, technical signals, Prophet-based ML evaluation, backtesting, and a desktop terminal-style interface. :contentReference[oaicite:0]{index=0} :contentReference[oaicite:1]{index=1}

## Overview

Crypto Terminal is a desktop application with a Python backend and an Electron frontend. It is designed as an educational prototype for short-horizon crypto market analysis. The current implementation includes:

- live market data for major coins
- Reddit-based sentiment ingestion
- local sentiment analysis through Ollama
- technical forecasting logic
- Prophet-based ML evaluation
- signal generation and history
- backtesting and analytics views
- local SQLite persistence :contentReference[oaicite:2]{index=2} :contentReference[oaicite:3]{index=3} :contentReference[oaicite:4]{index=4}

## Current Feature Set

### Data and Intelligence
- Binance market data integration
- Reddit post ingestion by coin/topic
- local LLM sentiment analysis via Ollama
- technical indicator-based directional prediction
- Prophet-based ML evaluation and cached model usage
- signal generation with explainability fields
- backtest storage and analytics tracking :contentReference[oaicite:5]{index=5}

### Desktop App
- Electron desktop app
- live chart panel
- forecast and signal panel
- analytics window
- signal history tab
- ML evaluation tab
- settings and model controls :contentReference[oaicite:6]{index=6} :contentReference[oaicite:7]{index=7}

## Tech Stack

### Backend
- Python
- Flask
- Flask-CORS
- Requests
- SQLite
- NumPy
- python-dotenv
- optional: pandas
- optional: Prophet :contentReference[oaicite:8]{index=8} :contentReference[oaicite:9]{index=9}

### Frontend
- Electron
- HTML/CSS/JavaScript
- lightweight-charts :contentReference[oaicite:10]{index=10}

### Local Model Runtime
- Ollama for self-hosted sentiment inference :contentReference[oaicite:11]{index=11}

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
│   ├── splash.js
│   └── package.json
├── package.json
├── start.sh
└── README.md