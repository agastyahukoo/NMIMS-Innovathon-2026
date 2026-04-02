# Crypto Terminal

A self-hosted crypto intelligence terminal built for **NMIMS Innovathon 2026**, it's a **Self-Hosted LLM Crypto Sentiment & Price Prediction Terminal**. The app combines market data, Reddit sentiment, local LLM analysis, technical signals, Prophet-based ML evaluation, backtesting, and a desktop terminal-style interface.

## Overview

Crypto Terminal is a desktop application with a Python backend and an Electron frontend. We have a lot of features suh as. 

- live market data for major coins
- Reddit-based sentiment ingestion
- local sentiment analysis through Ollama
- technical forecasting logic
- Prophet-based ML evaluation
- signal generation and history
- backtesting and analytics views
- local SQLite persistence 

## Current Feature Set

### Data and Intelligence
- Binance market data integration
- Reddit post ingestion by coin/topic
- local LLM sentiment analysis via Ollama
- technical indicator-based directional prediction
- Prophet-based ML evaluation and cached model usage
- signal generation with explainability fields
- backtest storage and analytics tracking 

### Desktop App
- Electron desktop app
- live chart panel
- forecast and signal panel
- analytics window
- signal history tab
- ML evaluation tab
- settings and model controls 

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
- optional: Prophet 

### Frontend
- Electron
- HTML/CSS/JavaScript
- lightweight-charts 

### Local Model Runtime
- Ollama for self-hosted sentiment inference 

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