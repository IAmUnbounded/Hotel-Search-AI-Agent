# Hotel-Search-AI-Agent
AI Agent to get the best hotels
# Bright Data LangGraph AI Agent

This project demonstrates an AI agent using [LangGraph](https://github.com/langchain-ai/langgraph) that scrapes Reddit and Booking.com for hotel data using the Bright Data Model Context Protocol (MCP).

## Features
- Scrapes Reddit for hotel recommendations
- Scrapes Booking.com for hotel listings
- Produces a list of the top 5 hotels based on review scores

## MCP Server Setup

### 1. Install Dependencies
```sh
npm install
```

### 2. Set your Bright Data API key
Set your Bright Data MCP API key in the code file server.js

### 3. Run the MCP server
```sh
npm run start
```


## Agent Setup

### 1. Install dependencies
```sh
pip install -r requirements.txt
```

### 2. Set your Gemini API key
Set your Gemini API key in the code file main.py

### 3. Run the agent
```sh
python main.py
```

## Notes
- The code uses BrightData to parse Booking.com HTML. You may need to adjust selectors if Booking.com changes their layout.
- The agent is easily extendable to other sites or data sources.

## Dependencies
- langgraph
- requests
- brightdata mcp

---

For more information, see the [Bright Data MCP docs](https://docs.brightdata.com/introduction).
