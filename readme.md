##codeSmol-ts

Lazy coding agent in TypeScript - supports OpenRouter, Groq, and Anthropic APIs.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set your API key** (choose one):
   ```bash

   export OPENROUTER_API_KEY="your-key-here"
   
   export GROQ_API_KEY="your-key-here"

   export ANTHROPIC_API_KEY="your-key-here"
   ```

3. **Run the agent:**
   ```bash
   npm start
   # or
   tsx agent.ts
   ```

## Usage

Once running, you can:
- Ask the agent to code, read files, edit files, etc.
- Type `/c` to clear conversation history
- Type `/q` or `exit` to quit

## Available Tools

The agent has access to these tools:
- **read** - Read file with line numbers
- **write** - Write content to file
- **edit** - Replace text in file
- **glob** - Find files by pattern
- **grep** - Search files for regex pattern
- **bash** - Run shell commands
