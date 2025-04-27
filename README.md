<<<<<<< HEAD
# Hotel-Search-AI-Agent
AI Agent to get the best hotels
=======
# Bright Data LangGraph AI Agent

This project demonstrates an AI agent using [LangGraph](https://github.com/langchain-ai/langgraph) that scrapes Reddit and Booking.com for hotel data using the Bright Data Model Context Protocol (MCP).

## Features
- Scrapes Reddit for hotel recommendations
- Scrapes Booking.com for hotel listings
- Produces a list of the top 5 hotels based on review scores

## Setup

### 1. Install dependencies
```sh
pip install -r requirements.txt
```

### 2. Set your Bright Data API key
Set your Bright Data MCP API key as an environment variable:
```sh
$env:BRIGHTDATA_API_KEY="YOUR_BRIGHTDATA_API_KEY"   # PowerShell
# OR
export BRIGHTDATA_API_KEY="YOUR_BRIGHTDATA_API_KEY"  # Bash
```

### 3. Run the agent
```sh
python main.py
```

## Notes
- The code uses BeautifulSoup to parse Booking.com HTML. You may need to adjust selectors if Booking.com changes their layout.
- Make sure your Bright Data account has access to the MCP endpoint.
- The agent is easily extendable to other sites or data sources.

## Dependencies
- langgraph
- requests
- beautifulsoup4

---

For more information, see the [Bright Data MCP docs](https://docs.brightdata.com/introduction).
>>>>>>> 84892fe (Add initial setup for brightdata api agent)
