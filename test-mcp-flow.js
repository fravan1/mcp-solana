// test-mcp-agent.js
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import readline from 'readline';

// Load environment variables
dotenv.config();

// Default configuration
const DEFAULT_CONFIG = {
  mcpServerUrl: process.env.MCP_SERVER_URL || 'http://localhost:3000/mcp',
  mcpApiKey: process.env.MCP_SERVER_API_KEY,
  llmModel: process.env.LLM_MODEL || 'claude-3-5-sonnet-20240620'
};

/**
 * Simple MCP Agent for Solana analysis
 */
class SimpleMCPAgent {
  constructor(config = {}) {
    // Merge default config with provided config
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Create session ID and request counter
    this.sessionId = `mcp-agent-${uuidv4()}`;
    this.requestIdCounter = 1;

    // Initialize memory
    this.memory = {
      messages: [],
      toolCalls: []
    };

    // Validate essential configuration
    this._validateConfig();

    console.log(`Agent initialized with session ID: ${this.sessionId}`);
  }

  _validateConfig() {
    if (!this.config.mcpApiKey) {
      throw new Error('MCP API key is required. Set it in your .env file or pass it in the config.');
    }
  }

  async callMcp(method, params = {}) {
    const requestId = this.requestIdCounter++;
    const startTime = Date.now();

    console.log(`\n[MCP CALL] Method: ${method}`);
    console.log(`Parameters: ${JSON.stringify(params, null, 2)}`);

    const payload = {
      jsonrpc: '2.0',
      method,
      params,
      id: requestId
    };

    try {
      const response = await fetch(this.config.mcpServerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.mcpApiKey
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[ERROR] HTTP ${response.status} (${response.statusText}) for method ${method}`);
        console.error(`Response: ${errorText}`);

        throw new Error(`HTTP error ${response.status} for method ${method}: ${response.statusText}`);
      }

      const jsonResponse = await response.json();

      if (jsonResponse.error) {
        console.error(`[ERROR] JSON-RPC error in method ${method}: ${jsonResponse.error.message} (code: ${jsonResponse.error.code})`);

        throw new Error(`MCP error in method ${method}: ${jsonResponse.error.message} (code: ${jsonResponse.error.code})`);
      }

      const duration = Date.now() - startTime;
      console.log(`[MCP RESPONSE] Method: ${method}, Time: ${duration}ms`);

      if (jsonResponse.result && jsonResponse.result.content && jsonResponse.result.content[0]) {
        console.log(`Content: ${jsonResponse.result.content[0].text.substring(0, 100)}...`);
      }

      // Record the tool call
      this.memory.toolCalls.push({
        method,
        params,
        requestId,
        timestamp: new Date().toISOString(),
        duration
      });

      return jsonResponse.result;
    } catch (error) {
      console.error(`[ERROR] Exception in MCP call: ${error.message}`);
      throw error;
    }
  }

  extractText(result, defaultValue = 'No data available') {
    if (result && result.content && result.content[0] && result.content[0].text) {
      return result.content[0].text;
    }
    return defaultValue;
  }

  getTools() {
    // Predefined tools available for the agent
    return [
      {
        name: 'solana_wallet_overview',
        description: 'Get an overview of a Solana wallet, including total value, number of tokens, and NFTs',
        parameters: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              description: 'Solana wallet address'
            }
          },
          required: ['address']
        }
      },
      {
        name: 'solana_wallet_tokens',
        description: 'Get tokens in a Solana wallet',
        parameters: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              description: 'Solana wallet address'
            },
            include_no_price: {
              type: 'boolean',
              description: 'Include tokens without price data'
            },
            limit: {
              type: 'integer',
              description: 'Maximum number of tokens to return'
            }
          },
          required: ['address']
        }
      },
      {
        name: 'solana_token_price',
        description: 'Get the current price of a Solana token',
        parameters: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Token symbol (e.g., SOL, USDC)'
            },
            mint_address: {
              type: 'string',
              description: 'Token mint address (alternative to symbol)'
            }
          },
          anyOf: [
            { required: ['symbol'] },
            { required: ['mint_address'] }
          ]
        }
      },
      {
        name: 'solana_wallet_pnl',
        description: 'Get Profit and Loss (PnL) data for a Solana wallet',
        parameters: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              description: 'Solana wallet address'
            }
          },
          required: ['address']
        }
      },
      {
        name: 'solana_market_sentiment',
        description: 'Get current Solana market sentiment based on token prices and program activity',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'solana_whale_movements',
        description: 'Get recent large transactions (whale movements) on Solana',
        parameters: {
          type: 'object',
          properties: {
            min_usd_amount: {
              type: 'number',
              description: 'Minimum USD value to consider a whale movement'
            },
            limit: {
              type: 'integer',
              description: 'Maximum number of movements to return'
            }
          }
        }
      },
      {
        name: 'solana_network_activity',
        description: 'Get overall Solana network activity metrics',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    ];
  }

  async generateWithLLM(prompt) {
    const model = this.config.llmModel;
    const isOpenAI = model.toLowerCase().includes('gpt');

    // Build conversation history
    let messages;
    let fullPrompt;

    if (isOpenAI) {
      // Format for OpenAI models
      messages = this.memory.messages.length > 0
        ? [...this.memory.messages, { role: 'user', content: prompt }]
        : [
            {
              role: 'system',
              content: 'You are an AI assistant specialized in Solana blockchain analysis. Use the available tools to help the user.'
            },
            { role: 'user', content: prompt }
          ];

      const result = await this.callMcp('openai_generate', {
        model,
        messages,
        max_tokens: 2000,
        session_id: this.sessionId
      });

      // Save the exchange in memory
      if (this.memory.messages.length === 0) {
        this.memory.messages.push({ role: 'system', content: messages[0].content });
      }
      this.memory.messages.push({ role: 'user', content: prompt });

      const responseContent = this.extractText(result);
      this.memory.messages.push({ role: 'assistant', content: responseContent });

      return responseContent;
    } else {
      // Format for Anthropic/Claude
      if (this.memory.messages.length === 0) {
        fullPrompt = 'You are an AI assistant specialized in Solana blockchain analysis. Use the available tools to help the user.\n\n';
      } else {
        fullPrompt = '';
      }

      // Add conversation history
      for (const msg of this.memory.messages) {
        if (msg.role === 'system') continue;

        if (msg.role === 'user') {
          fullPrompt += `Human: ${msg.content}\n\n`;
        } else if (msg.role === 'assistant') {
          fullPrompt += `Assistant: ${msg.content}\n\n`;
        } else if (msg.role === 'tool') {
          fullPrompt += `Tool Result (${msg.name}): ${msg.content}\n\n`;
        }
      }

      fullPrompt += `Human: ${prompt}\n\nAssistant: `;

      const result = await this.callMcp('anthropic_generate', {
        prompt: fullPrompt,
        model,
        max_tokens: 2000,
        session_id: this.sessionId
      });

      // Save the exchange in memory
      if (this.memory.messages.length === 0) {
        this.memory.messages.push({
          role: 'system',
          content: 'You are an AI assistant specialized in Solana blockchain analysis. Use the available tools to help the user.'
        });
      }
      this.memory.messages.push({ role: 'user', content: prompt });

      const responseContent = this.extractText(result);
      this.memory.messages.push({ role: 'assistant', content: responseContent });

      return responseContent;
    }
  }

  async clearContext() {
    try {
      await this.callMcp('clear_context', {
        session_id: this.sessionId
      });

      this.memory.messages = [];
      this.memory.toolCalls = [];

      console.log('[INFO] Context cleared successfully');
    } catch (error) {
      console.warn(`[WARN] Failed to clear context: ${error.message}`);
    }
  }

  async runInteractive() {
    console.log('\n====== SOLANA MCP AGENT ======');
    console.log('=============================\n');

    try {
      // Set up readline interface
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

      // Welcome message
      console.log('\n👋 Welcome to the Solana MCP Agent. You can:');
      console.log('   - Chat naturally about Solana wallets, tokens, prices, etc.');
      console.log('   - Use these commands:');
      console.log('     * /tools: list available tools');
      console.log('     * /clear: clear conversation history');
      console.log('     * /quit or /exit: exit the program\n');

      let running = true;

      while (running) {
        const userInput = await askQuestion('\n💬 You: ');

        if (userInput.trim().toLowerCase() === '/quit' || userInput.trim().toLowerCase() === '/exit') {
          running = false;
          continue;
        }

        if (userInput.trim().toLowerCase() === '/tools') {
          console.log('\n🛠️  Available tools:');

          for (const tool of this.getTools()) {
            console.log(`   - ${tool.name}: ${tool.description}`);
          }

          continue;
        }

        if (userInput.trim().toLowerCase() === '/clear') {
          await this.clearContext();
          console.log('\n🧹 Memory cleared');
          continue;
        }

        // Process regular input
        console.log('\n⏳ Thinking...');

        // Generate response
        const response = await this.generateWithLLM(userInput);

        // Display the response
        console.log(`\n🤖 Assistant: ${response}`);
      }

      // Clean up
      rl.close();
      await this.clearContext();

      console.log('\n👋 Thank you for using the Solana MCP Agent. Goodbye!');

    } catch (error) {
      console.error('\n❌ Error in interactive mode:');
      console.error(error.message);

      // Try to clean up
      try {
        await this.clearContext();
      } catch (cleanupError) {
        console.error(`Error during cleanup: ${cleanupError.message}`);
      }

      throw error;
    }
  }
}

/**
 * Main function
 */
async function main() {
  try {
    // Validate API key
    if (!process.env.MCP_SERVER_API_KEY) {
      console.error('\n❌ MCP API KEY not configured. Please set MCP_SERVER_API_KEY in your .env file.\n');
      process.exit(1);
    }

    const agent = new SimpleMCPAgent();
    await agent.runInteractive();

  } catch (error) {
    console.error('\n❌ Error running MCP Agent:');
    console.error(error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (process.argv[1] === process.argv[1]) {
  main();
}

export default SimpleMCPAgent;
