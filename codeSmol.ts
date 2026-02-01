import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as readline from 'readline';
import { glob as globSync } from 'glob';
const execAsync = promisify(exec);

interface ApiConfig {
  url: string;
  key: string;
  model: string;
  provider: 'openrouter' | 'groq' | 'anthropic';
}

function getApiConfig(): ApiConfig {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (openrouterKey) {
    return {
      url: 'https://openrouter.ai/api/v1/messages',
      key: openrouterKey,
      model: process.env.MODEL || 'anthropic/claude-opus-4.5',
      provider: 'openrouter'
    };
  } else if (groqKey) {
    return {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: groqKey,
      model: process.env.MODEL || 'llama-3.3-70b-versatile',
      provider: 'groq'
    };
  } else {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      key: anthropicKey || '',
      model: process.env.MODEL || 'claude-opus-4-5',
      provider: 'anthropic'
    };
  }
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m'; 

interface ToolArgs {
  [key: string]: any;
}

type ToolFunction = (args: ToolArgs) => string | Promise<string>;

interface ToolDefinition {
  description: string;
  params: { [key: string]: string };
  fn: ToolFunction;
}

function readFile(args: ToolArgs): string {
  const filePath = args.path as string;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const offset = args.offset || 0;
  const limit = args.limit || lines.length;
  const selected = lines.slice(offset, offset + limit);
  
  return selected
    .map((line, idx) => `${String(offset + idx + 1).padStart(4)}| ${line}`)
    .join('\n');
}

function writeFile(args: ToolArgs): string {
  fs.writeFileSync(args.path as string, args.content as string);
  return 'ok';
}

function editFile(args: ToolArgs): string {
  const filePath = args.path as string;
  const text = fs.readFileSync(filePath, 'utf-8');
  const old = args.old as string;
  const newStr = args.new as string;
  
  if (!text.includes(old)) {
    return 'error: old_string not found';
  }
  
  const count = (text.match(new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  
  if (!args.all && count > 1) {
    return `error: old_string appears ${count} times, must be unique (use all=true)`;
  }
  
  const replacement = args.all 
    ? text.split(old).join(newStr)
    : text.replace(old, newStr);
  
  fs.writeFileSync(filePath, replacement);
  return 'ok';
}

function globFiles(args: ToolArgs): string {
  const basePath = args.path || '.';
  const pattern = path.join(basePath, args.pat as string).replace('//', '/');
  const files = globSync(pattern, { nodir: false });
  
  const sorted = files.sort((a, b) => {
    try {
      const aStat = fs.statSync(a);
      const bStat = fs.statSync(b);
      if (!aStat.isFile()) return 1;
      if (!bStat.isFile()) return -1;
      return bStat.mtimeMs - aStat.mtimeMs;
    } catch {
      return 0;
    }
  });
  
  return sorted.join('\n') || 'none';
}

function grepFiles(args: ToolArgs): string {
  const pattern = new RegExp(args.pat as string);
  const basePath = args.path || '.';
  const files = globSync(path.join(basePath, '**/*'), { nodir: true });
  const hits: string[] = [];
  
  for (const filepath of files) {
    try {
      const content = fs.readFileSync(filepath, 'utf-8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (pattern.test(line)) {
          hits.push(`${filepath}:${idx + 1}:${line.trim()}`);
        }
      });
      if (hits.length >= 50) break;
    } catch {
      // Skip files that can't be read
    }
  }
  
  return hits.slice(0, 50).join('\n') || 'none';
}

async function runBash(args: ToolArgs): Promise<string> {
  return new Promise((resolve) => {
    const child = exec(args.cmd as string, {
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 10
    });
    
    let output = '';
    
    child.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach((line: string) => {
        if (line) {
          console.log(`  ${DIM}│ ${line}${RESET}`);
          output += line + '\n';
        }
      });
    });
    
    child.stderr?.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach((line: string) => {
        if (line) {
          console.log(`  ${DIM}│ ${line}${RESET}`);
          output += line + '\n';
        }
      });
    });
    
    child.on('close', (code) => {
      resolve(output.trim() || '(empty)');
    });
    
    child.on('error', (err) => {
      resolve(`error: ${err.message}`);
    });
  });
}

const TOOLS: { [key: string]: ToolDefinition } = {
  read: {
    description: 'Read file with line numbers (file path, not directory)',
    params: { path: 'string', offset: 'number?', limit: 'number?' },
    fn: readFile
  },
  write: {
    description: 'Write content to file',
    params: { path: 'string', content: 'string' },
    fn: writeFile
  },
  edit: {
    description: 'Replace old with new in file (old must be unique unless all=true)',
    params: { path: 'string', old: 'string', new: 'string', all: 'boolean?' },
    fn: editFile
  },
  glob: {
    description: 'Find files by pattern, sorted by mtime',
    params: { pat: 'string', path: 'string?' },
    fn: globFiles
  },
  grep: {
    description: 'Search files for regex pattern',
    params: { pat: 'string', path: 'string?' },
    fn: grepFiles
  },
  bash: {
    description: 'Run shell command',
    params: { cmd: 'string' },
    fn: runBash
  }
};

async function runTool(name: string, args: ToolArgs): Promise<string> {
  try {
    return await TOOLS[name].fn(args);
  } catch (err: any) {
    return `error: ${err.message}`;
  }
}

function makeSchema() {
  const result = [];
  
  for (const [name, def] of Object.entries(TOOLS)) {
    const properties: any = {};
    const required: string[] = [];
    
    for (const [paramName, paramType] of Object.entries(def.params)) {
      const isOptional = paramType.endsWith('?');
      const baseType = paramType.replace('?', '');
      
      properties[paramName] = {
        type: baseType === 'number' ? 'integer' : baseType
      };
      
      if (!isOptional) {
        required.push(paramName);
      }
    }
    
    result.push({
      name,
      description: def.description,
      input_schema: {
        type: 'object',
        properties,
        required
      }
    });
  }
  
  return result;
}
interface Message {
  role: 'user' | 'assistant' | 'system';
  content: any;
}
interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: any;
}
async function callApi(messages: Message[], systemPrompt: string, config: ApiConfig): Promise<any> {
  const headers: any = {
    'Content-Type': 'application/json'
  };
  
  let body: any;
  
  if (config.provider === 'anthropic' || config.provider === 'openrouter') {
    headers['anthropic-version'] = '2023-06-01';
    
    if (config.provider === 'openrouter') {
      headers['Authorization'] = `Bearer ${config.key}`;
    } else {
      headers['x-api-key'] = config.key;
    }
    
    body = {
      model: config.model,
      max_tokens: 1600,
      system: systemPrompt,
      messages,
      tools: makeSchema()
    };
  } else if (config.provider === 'groq') {
    headers['Authorization'] = `Bearer ${config.key}`;
    
    // Convert Anthropic messages to OpenAI format
    const openAiMessages: any[] = [
      { role: 'system', content: systemPrompt }
    ];
    
    for (const msg of messages) {
      if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          openAiMessages.push({
            role: 'tool',
            content: JSON.stringify(msg.content),
            tool_call_id: msg.content[0]?.tool_use_id || 'unknown'
          });
        } else {
          openAiMessages.push({
            role: 'user',
            content: msg.content
          });
        }
      } else if (msg.role === 'assistant') {
        if (Array.isArray(msg.content)) {
          const textContent = msg.content.find((b: any) => b.type === 'text');
          const toolUses = msg.content.filter((b: any) => b.type === 'tool_use');
          
          const assistantMsg: any = {
            role: 'assistant',
            content: textContent?.text || null
          };
          
          if (toolUses.length > 0) {
            assistantMsg.tool_calls = toolUses.map((tool: any) => ({
              id: tool.id,
              type: 'function',
              function: {
                name: tool.name,
                arguments: JSON.stringify(tool.input)
              }
            }));
          }
          
          openAiMessages.push(assistantMsg);
        } else {
          openAiMessages.push({
            role: 'assistant',
            content: msg.content
          });
        }
      }
    }
    
    // Convert tools to OpenAI format
    const openAiTools = makeSchema().map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema
      }
    }));
    
    body = {
      model: config.model,
      messages: openAiMessages,
      tools: openAiTools,
      tool_choice:"auto",
      max_tokens: 1600
    };
  }
  
  const response = await fetch(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }
  
  return await response.json();
}

function separator(): string {
  const width = process.stdout.columns || 80;
  return `${DIM}${'─'.repeat(Math.min(width, 80))}${RESET}`;
}

function renderMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
}

async function getUserInput(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const config = getApiConfig();
  console.log(`${BOLD}codeSmol${RESET} | ${DIM}${config.model} (${config.provider}) | ${process.cwd()}${RESET}\n`);
  
  const messages: Message[] = [];
  const systemPrompt = `Concise coding assistant. cwd: ${process.cwd()}`;
  
  while (true) {
    try {
      console.log(separator());
      const userInput = await getUserInput(`${BOLD}${BLUE}❯${RESET} `);
      console.log(separator());
      
      if (!userInput) continue;
      if (userInput === '/q' || userInput === 'exit') break;
      if (userInput === '/c') {
        messages.length = 0;
        console.log(`${GREEN}Cleared conversation${RESET}`);
        continue;
      }
      
      messages.push({ role: 'user', content: userInput });
      
      // Agentic loop
      while (true) {
        const response = await callApi(messages, systemPrompt, config);
        
        let contentBlocks: ContentBlock[] = [];
        
        if (config.provider === 'groq') {
          const choice = response.choices?.[0];
          const message = choice?.message;
          
          if (message?.content) {
            contentBlocks.push({ type: 'text', text: message.content });
          }
          
          if (message?.tool_calls) {
            for (const toolCall of message.tool_calls) {
              contentBlocks.push({
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.function.name,
                input: JSON.parse(toolCall.function.arguments)
              });
            }
          }
        } else {
          contentBlocks = response.content || [];
        }
        
        const toolResults: any[] = [];
        
        for (const block of contentBlocks) {
          if (block.type === 'text') {
            console.log(`\n${CYAN}${RESET} ${renderMarkdown(block.text || '')}`);
          }
          
          if (block.type === 'tool_use') {
            const toolName = block.name || '';
            const toolArgs = block.input || {};
            const argPreview = String(Object.values(toolArgs)[0] || '').slice(0, 50);
            console.log(`\n${GREEN}${toolName.charAt(0).toUpperCase() + toolName.slice(1)}${RESET}(${DIM}${argPreview}${RESET})`);
            
            const result = await runTool(toolName, toolArgs);
            const resultLines = result.split('\n');
            let preview = resultLines[0].slice(0, 60);
            if (resultLines.length > 1) {
              preview += ` ... +${resultLines.length - 1} lines`;
            } else if (resultLines[0].length > 60) {
              preview += '...';
            }
            console.log(`  ${DIM}⎿  ${preview}${RESET}`);
            
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result
            });
          }
        }
        
        messages.push({ role: 'assistant', content: contentBlocks });
        
        if (toolResults.length === 0) break;
        messages.push({ role: 'user', content: toolResults });
      }
      
      console.log();
      
    } catch (err: any) {
      if (err.message?.includes('SIGINT')) break;
      console.log(`${RED}Error: ${err.message}${RESET}`);
    }
  }
}

main().catch(console.error);