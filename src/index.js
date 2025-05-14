import express from 'express';
import VybeService from './services/vybe-service.js';
import { createClient } from 'redis';
import { z } from 'zod';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import NodeCache from 'node-cache';
import pino from 'pino';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

// Para obtener el __dirname en módulos ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


dotenv.config();

const logger = pino({
	level: process.env.LOG_LEVEL || 'info',
	transport: {
		target: 'pino-pretty',
		options: {
			colorize: true,
		},
	},
});

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY || '',
});

const anthropic = new Anthropic({
	apiKey: process.env.ANTHROPIC_API_KEY || '',
});

const redisClient = process.env.REDIS_URL ?
	createClient({ url: process.env.REDIS_URL }) :
	null;

if(redisClient) {
	redisClient.connect().catch(err => {
		logger.error('Error connecting to Redis:', err);
	});
}

const memoryCache = new NodeCache({
	stdTTL: 120,
	checkperiod: 60,
	useClones: false,
});

const contextStore = new Map();

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 100,
	standardHeaders: true,
	legacyHeaders: false,
	message: 'Too many requests from this IP, please try again after 15 minutes',
});

app.use('/mcp', apiLimiter);

function authMiddleware(req, res, next) {
	const apiKey = req.headers['x-api-key'];

	if(!apiKey || apiKey !== process.env.MCP_SERVER_API_KEY) {
		logger.warn({ ip: req.ip }, 'Unauthorized access attempt');
		return res.status(401).json({
			jsonrpc: '2.0',
			error: {
				code: -32000,
				message: 'Unauthorized',
			},
			id: null,
		});
	}

	next();
}

app.use('/mcp', authMiddleware);

app.post('/mcp', async (req, res) => {
	const requestStart = Date.now();
	const { jsonrpc, method, params, id } = req.body;

	logger.info({
		method,
		id,
		ip: req.ip,
		requestId: `${ Date.now() }-${ Math.random().toString(36).substring(2, 15) }`,
	}, 'MCP request received');

	if(jsonrpc !== '2.0' || !method || !id) {
		return res.status(400).json({
			jsonrpc: '2.0',
			error: {
				code: -32600,
				message: 'Invalid JSON-RPC request',
			},
			id: null,
		});
	}

	try {
		if(!method.includes('_generate') && !method.includes('context')) {
			const cacheKey = `${ method }:${ JSON.stringify(params) }`;
			const cachedResult = memoryCache.get(cacheKey);

			if(cachedResult) {
				logger.debug({ method, id, duration: Date.now() - requestStart }, 'Response served from cache');
				return res.json({
					jsonrpc: '2.0',
					result: cachedResult,
					id,
				});
			}

			if(redisClient && redisClient.isReady) {
				try {
					const redisResult = await redisClient.get(cacheKey);
					if(redisResult) {
						const parsedResult = JSON.parse(redisResult);
						memoryCache.set(cacheKey, parsedResult);
						logger.debug({ method, id, duration: Date.now() - requestStart }, 'Response served from Redis');
						return res.json({
							jsonrpc: '2.0',
							result: parsedResult,
							id,
						});
					}
				} catch(redisError) {
					logger.error({ error: redisError }, 'Error querying Redis');
				}
			}
		}

		let result;

		switch(method) {
			case 'openai_generate':
				result = await handleOpenAIGenerate(params);
				break;
			case 'anthropic_generate':
				result = await handleAnthropicGenerate(params);
				break;
			case 'clear_context':
				result = await handleClearContext(params);
				break;
			case 'solana_wallet_overview':
				result = await handleSolanaWalletOverview(params);
				break;
			case 'solana_wallet_tokens':
				result = await handleSolanaWalletTokens(params);
				break;
			case 'solana_wallet_nfts':
				result = await handleSolanaWalletNFTs(params);
				break;
			case 'solana_wallet_pnl':
				result = await handleSolanaWalletPnL(params);
				break;
			case 'solana_token_details':
				result = await handleSolanaTokenDetails(params);
				break;
			case 'solana_token_price':
				result = await handleSolanaTokenPrice(params);
				break;
			case 'solana_token_ohlc':
				result = await handleSolanaTokenOHLC(params);
				break;
			case 'solana_token_holders':
				result = await handleSolanaTokenHolders(params);
				break;
			case 'solana_program_details':
				result = await handleSolanaProgramDetails(params);
				break;
			case 'solana_program_metrics':
				result = await handleSolanaProgramMetrics(params);
				break;
			case 'solana_program_users':
				result = await handleSolanaProgramUsers(params);
				break;
			case 'solana_token_transfers':
				result = await handleSolanaTokenTransfers(params);
				break;
			case 'solana_trades':
				result = await handleSolanaTrades(params);
				break;
			case 'solana_whale_movements':
				result = await handleSolanaWhaleMovements(params);
				break;
			case 'solana_market_sentiment':
				result = await handleSolanaMarketSentiment(params);
				break;
			case 'solana_network_activity':
				result = await handleSolanaNetworkActivity(params);
				break;
			case 'solana_cross_analysis':
				result = await handleSolanaCrossAnalysis(params);
				break;
			default:
				logger.warn({ method }, 'Method not found');
				return res.status(404).json({
					jsonrpc: '2.0',
					error: {
						code: -32601,
						message: `Method '${ method }' not found`,
					},
					id,
				});
		}

		if(!method.includes('_generate') && !method.includes('context')) {
			const cacheKey = `${ method }:${ JSON.stringify(params) }`;
			memoryCache.set(cacheKey, result);
			if(redisClient && redisClient.isReady &&
				(method.includes('_overview') || method.includes('_details') || method.includes('_holders'))) {
				try {
					await redisClient.set(cacheKey, JSON.stringify(result), {
						EX: 300,
					});
				} catch(redisError) {
					logger.error({ error: redisError }, 'Error saving to Redis');
				}
			}
		}

		logger.info({
			method,
			id,
			duration: Date.now() - requestStart,
		}, 'MCP request completed');

		res.json({
			jsonrpc: '2.0',
			result,
			id,
		});

	} catch(error) {
		logger.error({
			method,
			id,
			error: error.message,
			stack: error.stack,
			duration: Date.now() - requestStart,
		}, `Error handling method '${ method }'`);

		res.status(error.httpCode || 500).json({
			jsonrpc: '2.0',
			error: {
				code: error.code || -32603,
				message: error.message || 'Internal server error',
			},
			id,
		});
	}
});

async function handleOpenAIGenerate({ prompt, model = 'gpt-4o', max_tokens = 1000, session_id }) {
	if(!prompt || typeof prompt !== 'string') {
		const error = new Error('Prompt is required and must be a string');
		error.code = -32602;
		throw error;
	}
	if(!session_id) {
		const error = new Error('session_id is required');
		error.code = -32602;
		throw error;
	}

	try {
		const previousMessages = contextStore.get(session_id) || [];
		const messages = [
			...previousMessages,
			{ role: 'user', content: prompt },
		];

		let attempts = 0;
		const maxAttempts = 3;
		let response;

		while(attempts < maxAttempts) {
			try {
				response = await openai.chat.completions.create({
					model,
					messages,
					max_tokens,
				});
				break;
			} catch(apiError) {
				attempts++;
				if(attempts >= maxAttempts ||
					!(apiError.status === 429 || apiError.status >= 500)) {
					throw apiError;
				}
				const waitTime = 2 ** attempts * 1000;
				logger.warn({ attempts, waitTime }, 'Retrying OpenAI request');
				await new Promise(resolve => setTimeout(resolve, waitTime));
			}
		}

		const responseContent = response.choices[0].message.content;
		const updatedMessages = [
			...messages,
			{ role: 'assistant', content: responseContent },
		];

		let contextToStore = updatedMessages;
		if(updatedMessages.length > 10) {
			contextToStore = [
				updatedMessages[0],
				...updatedMessages.slice(-9),
			];
		}
		contextStore.set(session_id, contextToStore);

		return {
			content: [ { type: 'text', text: responseContent } ],
		};
	} catch(error) {
		logger.error({ error: error.message, stack: error.stack }, 'Error in OpenAI');
		const mcpError = new Error(`OpenAI error: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleAnthropicGenerate({
	prompt,
	model = 'claude-3-5-sonnet-20240620',
	max_tokens = 1000,
	session_id,
}) {
	if(!prompt || typeof prompt !== 'string') {
		const error = new Error('Prompt is required and must be a string');
		error.code = -32602;
		throw error;
	}
	if(!session_id) {
		const error = new Error('session_id is required');
		error.code = -32602;
		throw error;
	}

	try {
		const previousMessages = contextStore.get(session_id) || [];
		const messages = [
			...previousMessages,
			{ role: 'user', content: prompt },
		];

		let attempts = 0;
		const maxAttempts = 3;
		let response;

		while(attempts < maxAttempts) {
			try {
				response = await anthropic.messages.create({
					model,
					max_tokens,
					messages,
				});
				break;
			} catch(apiError) {
				attempts++;
				if(attempts >= maxAttempts ||
					!(apiError.status === 429 || apiError.status >= 500)) {
					throw apiError;
				}
				const waitTime = 2 ** attempts * 1000;
				logger.warn({ attempts, waitTime }, 'Retrying Anthropic request');
				await new Promise(resolve => setTimeout(resolve, waitTime));
			}
		}

		const responseContent = response.content[0].text;
		const updatedMessages = [
			...messages,
			{ role: 'assistant', content: responseContent },
		];
		let contextToStore = updatedMessages;
		if(updatedMessages.length > 10) {
			contextToStore = [
				updatedMessages[0],
				...updatedMessages.slice(-9),
			];
		}
		contextStore.set(session_id, contextToStore);

		return {
			content: [ { type: 'text', text: responseContent } ],
		};
	} catch(error) {
		logger.error({ error: error.message, stack: error.stack }, 'Error in Anthropic');
		const mcpError = new Error(`Anthropic error: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleClearContext({ session_id }) {
	if(!session_id) {
		const error = new Error('session_id is required');
		error.code = -32602;
		throw error;
	}
	contextStore.delete(session_id);
	return {
		content: [ { type: 'text', text: 'Context cleared successfully' } ],
	};
}

// Solución para el archivo mcp-server.js

// Reemplaza esta función en tu archivo
async function handleSolanaWalletOverview({ address }) {
	if(!address) {
		const error = new Error('Wallet address is required');
		error.code = -32602;
		throw error;
	}
	try {
		const [ tokensResult, nftsResult ] = await Promise.all([
			VybeService.getWalletTokens(address, { includeNoPriceBalance: true }),
			VybeService.getWalletNfts(address, { includeNoPriceBalance: true }),
		]);

		let totalUsdValue = 0;
		let tokenCount = 0;
		let nftCount = 0;

		if(tokensResult && tokensResult.data) {
			tokenCount = tokensResult.data.length;
			totalUsdValue += tokensResult.data.reduce((sum, token) => sum + (token.valueUsd || 0), 0);
		}

		if(nftsResult && nftsResult.data) {
			nftCount = nftsResult.data.length;
			totalUsdValue += nftsResult.data.reduce((sum, nft) => sum + (nft.valueUsd || nft.usdPrice || 0), 0);
		}

		// Solución: Verificar que totalUsdValue sea realmente un número
		// SOLUCIÓN CORRECTA - Verifica que totalUsdValue sea un número
		const formattedUsdValue = typeof totalUsdValue === 'number' ?
			totalUsdValue :
			'N/A';
		return {
			content: [ {
				type: 'text',
				text: `Wallet Overview for ${ address }:
Total USD Value: $${ formattedUsdValue }
Number of Tokens: ${ tokenCount }
Number of NFTs: ${ nftCount }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message, address }, 'Error getting wallet overview');
		const mcpError = new Error(`Error fetching Solana data: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaWalletTokens({ address, include_no_price = false, limit = 100 }) {
	if(!address) {
		const error = new Error('Wallet address is required');
		error.code = -32602;
		throw error;
	}
	try {
		const result = await VybeService.getWalletTokens(address, {
			includeNoPriceBalance: include_no_price,
			limit,
			sortByDesc: 'valueUsd',
		});
		let formattedTokens = '';
		if(result && result.data && result.data.length > 0) {
			result.data.forEach((token, index) => {
				const value = token.valueUsd ? `$${ token.valueUsd }` : 'No valuation';
				const amount = token.amount ? token.amount.toLocaleString() : '0';
				formattedTokens += `\n${ index + 1 }. ${ token.symbol || token.name || 'Token' }: ${ amount } (${ value })`;
			});
		} else {
			formattedTokens = '\nNo tokens found';
		}
		return {
			content: [ {
				type: 'text',
				text: `Tokens in wallet ${ address }:${ formattedTokens }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message, address }, 'Error getting wallet tokens');
		const mcpError = new Error(`Error fetching Solana tokens: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaWalletNFTs({ address, include_no_price = false, limit = 100 }) {
	if(!address) {
		const error = new Error('Wallet address is required');
		error.code = -32602;
		throw error;
	}
	try {
		const result = await VybeService.getWalletNfts(address, {
			includeNoPriceBalance: include_no_price,
			limit,
			sortByDesc: 'valueUsd',
		});
		let formattedNFTs = '';
		if(result && result.data && result.data.length > 0) {
			result.data.forEach((nft, index) => {
				const value = nft.valueUsd || nft.usdPrice ? `$${ (nft.valueUsd || nft.usdPrice) }` : 'No valuation';
				formattedNFTs += `\n${ index + 1 }. ${ nft.name || 'NFT' } (${ value })`;
			});
		} else {
			formattedNFTs = '\nNo NFTs found';
		}
		return {
			content: [ {
				type: 'text',
				text: `NFTs in wallet ${ address }:${ formattedNFTs }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message, address }, 'Error getting wallet NFTs');
		const mcpError = new Error(`Error fetching Solana NFTs: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaWalletPnL({ address }) {
	if(!address) {
		const error = new Error('Wallet address is required');
		error.code = -32602;
		throw error;
	}
	try {
		const result = await VybeService.getWalletPnl(address);
		const performanceData = result?.data?.performance || {};
		const tradesData = result?.data?.trades || {};
		return {
			content: [ {
				type: 'text',
				text: `PnL Analysis for ${ address }:
Total PnL: ${ performanceData.totalPnlUsd ? `$${ performanceData.totalPnlUsd }` : 'Not available' }
PnL Percentage: ${ performanceData.totalPnlPercent ? `${ performanceData.totalPnlPercent }%` : 'Not available' }
Total Trades: ${ tradesData.count || 0 }
Profitable Trades: ${ tradesData.profitableCount || 0 }
Win/Loss Ratio: ${ tradesData.winLossRatio ? tradesData.winLossRatio : 'Not available' }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message, address }, 'Error getting wallet PnL');
		const mcpError = new Error(`Error fetching performance data: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaTokenDetails({ mint_address }) {
	if(!mint_address) {
		const error = new Error('Token mint address is required');
		error.code = -32602;
		throw error;
	}
	try {
		const result = await VybeService.getTokenDetails(mint_address);
		const tokenData = result?.data || {};
		return {
			content: [ {
				type: 'text',
				text: `Token Details for ${ mint_address }:
Name: ${ tokenData.name || 'Not available' }
Symbol: ${ tokenData.symbol || 'Not available' }
Price: ${ tokenData.price ? `$${ Number(tokenData.price).toFixed(6) }` : 'Not available' }
Total Supply: ${ tokenData.supply ? Number(tokenData.supply).toLocaleString() : 'Not available' }
24h Change: ${ tokenData.priceChange24h ? `${ Number(tokenData.priceChange24h) }%` : 'Not available' }
24h Volume: ${ tokenData.volume24h ? `$${ Number(tokenData.volume24h).toLocaleString() }` : 'Not available' }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message, mint_address }, 'Error getting token details');
		const mcpError = new Error(`Error fetching token details: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaTokenPrice({ mint_address, symbol }) {
	if(!mint_address && !symbol) {
		const error = new Error('Either mint_address or symbol is required');
		error.code = -32602;
		throw error;
	}

	const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
	const SOL_PYTH_FEED_ID_MAINNET = 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG';
	const USDC_PYTH_FEED_ID_MAINNET = 'Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD';

	const COINGECKO_ID_MAP = {
		'SOL': 'solana',
		'USDC': 'usd-coin',
		'USDT': 'tether',
		'BONK': 'bonk',
		'JUP': 'jupiter-aggregator',
		'PYTH': 'pyth-network',
		'WIF': 'dogwifhat',
	};

	let tokenPrice;
	let determinedSymbol = symbol; // Symbol used for display and some lookups
	let anErrorOccurred = null;

	try {
		// 1. Try VybeService.getTokenDetails if mint_address is provided
		if(mint_address) {
			try {
				const detailsResult = await VybeService.getTokenDetails(mint_address);
				if(detailsResult?.data?.price) {
					tokenPrice = parseFloat(detailsResult.data.price);
					determinedSymbol = detailsResult.data.symbol || mint_address;
					logger.debug({
						method: 'handleSolanaTokenPrice',
						source: 'VybeDetails',
						mint_address,
						price: tokenPrice,
					}, 'Price found via Vybe getTokenDetails');
				} else {
					determinedSymbol = detailsResult?.data?.symbol || symbol; // Keep symbol if Vybe gave one
				}
				if(mint_address === WRAPPED_SOL_MINT && !determinedSymbol) {
					determinedSymbol = 'SOL'; // Ensure wSOL gets treated as SOL for symbol lookups
				}
			} catch(vybeDetailsError) {
				logger.warn({
					method: 'handleSolanaTokenPrice',
					error: vybeDetailsError.message,
				}, 'Vybe getTokenDetails failed or gave no price.');
				anErrorOccurred = vybeDetailsError;
			}
		}

		// 2. If no price yet and mint_address available, try CoinGecko by contract address
		if(typeof tokenPrice === 'undefined' && mint_address) {
			try {
				const cgContractUrl = `https://api.coingecko.com/api/v3/coins/solana/contract/${ mint_address }`;
				const cgResponse = await fetch(cgContractUrl);
				if(cgResponse.ok) {
					const cgData = await cgResponse.json();
					if(cgData?.market_data?.current_price?.usd) {
						tokenPrice = parseFloat(cgData.market_data.current_price.usd);
						determinedSymbol = cgData.symbol?.toUpperCase() || determinedSymbol || mint_address;
						logger.debug({
							method: 'handleSolanaTokenPrice',
							source: 'CoinGeckoContract',
							mint_address,
							price: tokenPrice,
						}, 'Price found via CoinGecko by contract');
						anErrorOccurred = null; // Reset error if we found a price
					}
				} else {
					logger.warn({
						method: 'handleSolanaTokenPrice',
						status: cgResponse.status,
					}, 'CoinGecko by contract request failed.');
				}
			} catch(cgContractError) {
				logger.warn({
					method: 'handleSolanaTokenPrice',
					error: cgContractError.message,
				}, 'CoinGecko by contract lookup failed.');
				anErrorOccurred = cgContractError;
			}
		}

		// 3. If no price yet and a symbol is available (either from input or VybeDetails), try CoinGecko by mapped ID
		if(typeof tokenPrice === 'undefined' && determinedSymbol) {
			const coingeckoId = COINGECKO_ID_MAP[determinedSymbol.toUpperCase()];
			if(coingeckoId) {
				try {
					const cgSimpleUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${ coingeckoId }&vs_currencies=usd`;
					const cgResponse = await fetch(cgSimpleUrl);
					if(cgResponse.ok) {
						const cgData = await cgResponse.json();
						if(cgData?.[coingeckoId]?.usd) {
							tokenPrice = parseFloat(cgData[coingeckoId].usd);
							logger.debug({
								method: 'handleSolanaTokenPrice',
								source: 'CoinGeckoSimple',
								symbol: determinedSymbol,
								price: tokenPrice,
							}, 'Price found via CoinGecko by symbol');
							anErrorOccurred = null;
						}
					} else {
						logger.warn({
							method: 'handleSolanaTokenPrice',
							status: cgResponse.status,
						}, 'CoinGecko simple price request failed.');
					}
				} catch(cgSimpleError) {
					logger.warn({
						method: 'handleSolanaTokenPrice',
						error: cgSimpleError.message,
					}, 'CoinGecko simple price lookup failed.');
					anErrorOccurred = cgSimpleError;
				}
			}
		}

		// 4. If no price yet and a symbol is available, try Pyth via VybeService
		if(typeof tokenPrice === 'undefined' && determinedSymbol) {
			let feedIdToUse;
			const upperSymbol = determinedSymbol.toUpperCase();
			if(upperSymbol === 'SOL') feedIdToUse = SOL_PYTH_FEED_ID_MAINNET;
			else if(upperSymbol === 'USDC') feedIdToUse = USDC_PYTH_FEED_ID_MAINNET;
			else {
				try {
					const pythAccounts = await VybeService.getPythAccounts();
					const matchingFeed = pythAccounts?.data?.find(acc => acc.symbol && acc.symbol.toUpperCase() === upperSymbol);
					if(matchingFeed?.priceFeedId) feedIdToUse = matchingFeed.priceFeedId;
				} catch(pythListError) {
					logger.warn({
						method: 'handleSolanaTokenPrice',
						error: pythListError.message,
					}, 'Failed to get Pyth accounts list from Vybe.');
					anErrorOccurred = pythListError;
				}
			}

			if(feedIdToUse) {
				try {
					const priceResult = await VybeService.getPythPrice(feedIdToUse);
					if(priceResult?.data?.price) {
						tokenPrice = parseFloat(priceResult.data.price);
						logger.debug({
							method: 'handleSolanaTokenPrice',
							source: 'VybePyth',
							symbol: determinedSymbol,
							price: tokenPrice,
						}, 'Price found via Vybe Pyth');
						anErrorOccurred = null;
					}
				} catch(vybePythError) {
					logger.warn({
						method: 'handleSolanaTokenPrice',
						error: vybePythError.message,
					}, 'Vybe Pyth price lookup failed.');
					anErrorOccurred = vybePythError;
				}
			} else if(typeof tokenPrice === 'undefined' && anErrorOccurred === null) {
				// Only set this error if no other specific error has occurred yet and no feed ID was found
				anErrorOccurred = new Error(`No Pyth price feed identified for symbol ${ determinedSymbol }`);
			}
		}

		// Final check and response
		if(typeof tokenPrice === 'number') {
			return {
				content: [ {
					type: 'text',
					text: `Current price of ${ determinedSymbol || mint_address || symbol } is $${ tokenPrice.toFixed(6) } USD.`,
				} ],
			};
		} else {
			const finalErrorMessage = anErrorOccurred ? anErrorOccurred.message : `Could not determine price for ${ mint_address || symbol }`;
			throw new Error(finalErrorMessage);
		}

	} catch(error) {
		logger.error({
			error: error.message,
			stack: error.stack,
			mint_address,
			symbol,
		}, 'Error in handleSolanaTokenPrice');
		const mcpError = new Error(`Error fetching price: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaTokenOHLC({ mint_address, resolution = '1d', limit = 7 }) {
	if(!mint_address) {
		const error = new Error('Token mint address is required');
		error.code = -32602;
		throw error;
	}
	try {
		const result = await VybeService.getTokenOhlc(mint_address, {
			resolution,
			limit: parseInt(limit),
		});
		let formattedData = '';
		if(result?.data && result.data.length > 0) {
			result.data.forEach(candle => {
				const date = new Date(candle.time * 1000).toLocaleDateString();
				const open = typeof candle.open === 'number' ? candle.open.toFixed(6) : 'N/A';
				const high = typeof candle.high === 'number' ? candle.high.toFixed(6) : 'N/A';
				const low = typeof candle.low === 'number' ? candle.low.toFixed(6) : 'N/A';
				const close = typeof candle.close === 'number' ? candle.close.toFixed(6) : 'N/A';
				formattedData += `\n${ date }: Open $${ open }, High $${ high }, Low $${ low }, Close $${ close }`;
			});
		} else {
			formattedData = '\nNo OHLC data available';
		}
		return {
			content: [ {
				type: 'text',
				text: `OHLC data for token (resolution: ${ resolution }):${ formattedData }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message, mint_address }, 'Error getting token OHLC data');
		const mcpError = new Error(`Error fetching historical data: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaTokenHolders({ mint_address, limit = 10 }) {
	if(!mint_address) {
		const error = new Error('Token mint address is required');
		error.code = -32602;
		throw error;
	}
	try {
		const result = await VybeService.getTopTokenHolders(mint_address, {
			limit: parseInt(limit),
		});
		let formattedData = '';
		if(result?.data && result.data.length > 0) {
			result.data.forEach((holder, index) => {
				const percentage = holder.percentage ? `(${ (holder.percentage * 100) }%)` : '';
				const amount = holder.amount ? Number(holder.amount).toLocaleString() : 'Unknown';
				formattedData += `\n${ index + 1 }. ${ holder.owner || 'Unknown' }: ${ amount } ${ percentage }`;
			});
		} else {
			formattedData = '\nNo holder data available';
		}
		return {
			content: [ {
				type: 'text',
				text: `Top ${ limit } token holders:${ formattedData }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message, mint_address }, 'Error getting token holders');
		const mcpError = new Error(`Error fetching holder data: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaProgramDetails({ program_id }) {
	if(!program_id) {
		const error = new Error('Program ID is required');
		error.code = -32602;
		throw error;
	}
	try {
		const result = await VybeService.getProgramDetails(program_id);
		const programData = result?.data || {};
		return {
			content: [ {
				type: 'text',
				text: `Program Details for ${ program_id }:
Name: ${ programData.name || 'Not available' }
Type: ${ programData.type || 'Not available' }
Labels: ${ programData.labels ? programData.labels.join(', ') : 'Not available' }
Entity: ${ programData.entityName || 'Not available' }
Description: ${ programData.description || 'Not available' }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message, program_id }, 'Error getting program details');
		const mcpError = new Error(`Error fetching program details: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaProgramMetrics({ program_id, range = '7d' }) {
	if(!program_id) {
		const error = new Error('Program ID is required');
		error.code = -32602;
		throw error;
	}
	try {
		const [ instructionsResult, transactionsResult, usersResult ] = await Promise.all([
			VybeService.getProgramInstructionsCountTimeSeries(program_id, { range }),
			VybeService.getProgramTransactionsCountTimeSeries(program_id, { range }),
			VybeService.getProgramActiveUsersTimeSeries(program_id, { range }),
		]);
		const instructionsTotal = instructionsResult?.data?.reduce((sum, d) => sum + d.count, 0) || 0;
		const transactionsTotal = transactionsResult?.data?.reduce((sum, d) => sum + d.count, 0) || 0;
		const usersTotal = usersResult?.data?.reduce((sum, d) => sum + d.count, 0) || 0;
		return {
			content: [ {
				type: 'text',
				text: `Program Metrics for ${ program_id } (last ${ range }):
Instructions: ${ instructionsTotal.toLocaleString() }
Transactions: ${ transactionsTotal.toLocaleString() }
Active Users: ${ usersTotal.toLocaleString() }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message, program_id }, 'Error getting program metrics');
		const mcpError = new Error(`Error fetching program metrics: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaProgramUsers({ program_id, days = 7, limit = 10 }) {
	if(!program_id) {
		const error = new Error('Program ID is required');
		error.code = -32602;
		throw error;
	}
	try {
		const result = await VybeService.getProgramActiveUsers(program_id, {
			days: parseInt(days),
			limit: parseInt(limit),
			sortByDesc: 'instructions',
		});
		let formattedData = '';
		if(result?.data && result.data.length > 0) {
			result.data.forEach((user, index) => {
				const instructions = user.instructions || user.instructionCount || 0;
				const transactions = user.transactions || user.transactionCount || 0;
				formattedData += `\n${ index + 1 }. ${ user.walletAddress || user.user }: ${ instructions } instructions, ${ transactions } transactions`;
			});
		} else {
			formattedData = '\nNo user data available';
		}
		return {
			content: [ {
				type: 'text',
				text: `Top ${ limit } active users for program (last ${ days } days):${ formattedData }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message, program_id }, 'Error getting program users');
		const mcpError = new Error(`Error fetching user data: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaTokenTransfers({ mint_address, limit = 10 }) {
	if(!mint_address) {
		const error = new Error('Token mint address is required');
		error.code = -32602;
		throw error;
	}
	try {
		const result = await VybeService.getTokenTransfers({
			mintAddress: mint_address,
			limit: parseInt(limit),
			sortByDesc: 'blockTime',
		});
		let formattedData = '';
		if(result?.data && result.data.length > 0) {
			result.data.forEach((transfer, index) => {
				const date = new Date(transfer.blockTime * 1000).toLocaleString();
				const amount = transfer.transferAmount ? Number(transfer.transferAmount).toLocaleString() : 'Unknown';
				const usdValue = transfer.transferUsdValue ? `($${ Number(transfer.transferUsdValue)
				})` : '';
				formattedData += `\n${ index + 1 }. ${ date }: ${ transfer.senderAddress } → ${ transfer.receiverAddress }, ${ amount } ${ usdValue }`;
			});
		} else {
			formattedData = '\nNo transfer data available';
		}
		return {
			content: [ {
				type: 'text',
				text: `Recent token transfers:${ formattedData }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message, mint_address }, 'Error getting token transfers');
		const mcpError = new Error(`Error fetching transfer data: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaTrades({ mint_address, limit = 10 }) {
	if(!mint_address) {
		const error = new Error('Token mint address is required');
		error.code = -32602;
		throw error;
	}
	try {
		const result = await VybeService.getTokenTrades({
			mintAddress: mint_address,
			limit: parseInt(limit),
			sortByDesc: 'blockTime',
		});
		let formattedData = '';
		if(result?.data && result.data.length > 0) {
			result.data.forEach((trade, index) => {
				const date = new Date(trade.blockTime * 1000).toLocaleString();
				const type = trade.side === 'sell' ? 'Sell' : 'Buy';
				const amount = trade.baseAmount ? Number(trade.baseAmount).toLocaleString() : 'Unknown';
				const price = typeof trade.price === 'number' ? `at $${ trade.price.toFixed(6) }` : '';
				const usdValue = typeof trade.usdValue === 'number' ? `($${ trade.usdValue })` : '';
				formattedData += `\n${ index + 1 }. ${ date }: ${ type } of ${ amount } ${ trade.baseSymbol || '' } ${ price } ${ usdValue }`;
			});
		} else {
			formattedData = '\nNo trade data available';
		}
		return {
			content: [ {
				type: 'text',
				text: `Recent token trades:${ formattedData }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message, mint_address }, 'Error getting token trades');
		const mcpError = new Error(`Error fetching trade data: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaWhaleMovements({ min_usd_amount = 10000, limit = 10 }) {
	try {
		const result = await VybeService.getTokenTransfers({
			minUsdAmount: parseFloat(min_usd_amount),
			limit: parseInt(limit),
			sortByDesc: 'blockTime',
		});
		let formattedData = '';
		if(result?.data && result.data.length > 0) {
			result.data.forEach((transfer, index) => {
				const date = new Date(transfer.blockTime * 1000).toLocaleString();
				const amount = transfer.transferAmount ? Number(transfer.transferAmount).toLocaleString() : 'Unknown';
				const usdValue = transfer.transferUsdValue ? `($${ Number(transfer.transferUsdValue)
				})` : '';
				const symbol = transfer.mintSymbol || 'token';
				formattedData += `\n${ index + 1 }. ${ date }: ${ transfer.senderAddress } → ${ transfer.receiverAddress }, ${ amount } ${ symbol } ${ usdValue }`;
			});
		} else {
			formattedData = '\nNo whale movements available';
		}
		return {
			content: [ {
				type: 'text',
				text: `Whale movements (min. $${ min_usd_amount.toLocaleString() }):${ formattedData }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message }, 'Error getting whale movements');
		const mcpError = new Error(`Error fetching whale movements: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaMarketSentiment() {
	try {
		const programsResult = await VybeService.getProgramRanking({
			sortByDesc: 'userCount24h',
			limit: 5,
		});
		const tokensResult = await VybeService.getTokensSummary({
			sortByDesc: 'price',
			limit: 5,
		});
		let programsData = '';
		if(programsResult?.data && programsResult.data.length > 0) {
			programsResult.data.forEach((program, index) => {
				programsData += `\n${ index + 1 }. ${ program.name || program.programId }: ${ program.userCount24h || 0 } active users`;
			});
		} else {
			programsData = '\nNo program data available';
		}
		let tokensData = '';
		if(tokensResult?.data && tokensResult.data.length > 0) {
			tokensResult.data.forEach((token, index) => {
				const price = typeof token.price === 'number' ? `$${ token.price.toFixed(6) }` : 'N/A';
				const change = token.priceChange24h || token.price1d;
				const changeText = typeof change === 'number' ? `${ change }%` : 'N/A';
				tokensData += `\n${ index + 1 }. ${ token.symbol || token.mintAddress }: ${ price } (${ changeText } 24h)`;
			});
		} else {
			tokensData = '\nNo token data available';
		}
		return {
			content: [ {
				type: 'text',
				text: `Solana Market Sentiment:

TOP PROGRAMS BY ACTIVITY:${ programsData }

TOP TOKENS BY PRICE:${ tokensData }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message }, 'Error getting market sentiment');
		const mcpError = new Error(`Error fetching market sentiment: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaNetworkActivity() {
	try {
		const programsResult = await VybeService.getProgramRanking({
			limit: 10,
			sortByDesc: 'instructionCount24h',
		});
		let totalInstructions = 0;
		let totalTransactions = 0;
		let totalUsers = 0;
		if(programsResult?.data) {
			programsResult.data.forEach(program => {
				totalInstructions += program.instructionCount24h || 0;
				totalTransactions += program.transactionCount24h || 0;
				totalUsers += program.userCount24h || 0;
			});
		}
		return {
			content: [ {
				type: 'text',
				text: `Solana Network Activity (last 24h):

Instructions: ${ totalInstructions.toLocaleString() }
Transactions: ${ totalTransactions.toLocaleString() }
Active Users: ${ totalUsers.toLocaleString() }

Note: This data represents activity from the ${ programsResult?.data?.length || 0 } most active programs.`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message }, 'Error getting network activity');
		const mcpError = new Error(`Error fetching network activity: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

async function handleSolanaCrossAnalysis({ addresses }) {
	if(!addresses || !Array.isArray(addresses) || addresses.length === 0) {
		const error = new Error('An array of addresses is required');
		error.code = -32602;
		throw error;
	}
	try {
		const tokenPromises = addresses.map(address =>
			VybeService.getWalletTokens(address, { includeNoPriceBalance: true }),
		);
		const tokenResults = await Promise.all(tokenPromises);
		const tokensByMint = {};
		const addressNames = {};
		addresses.forEach((address, index) => {
			addressNames[address] = `Wallet ${ index + 1 }`;
		});
		tokenResults.forEach((result, index) => {
			const address = addresses[index];
			if(result?.data) {
				result.data.forEach(token => {
					if(!tokensByMint[token.mintAddress]) {
						tokensByMint[token.mintAddress] = {
							symbol: token.symbol || 'Unknown',
							holders: {},
						};
					}
					tokensByMint[token.mintAddress].holders[address] = {
						amount: token.amount,
						usdValue: token.valueUsd || 0,
					};
				});
			}
		});
		const commonTokens = Object.entries(tokensByMint)
			.filter(([ mint, data ]) => Object.keys(data.holders).length > 1)
			.sort((a, b) => Object.keys(b[1].holders).length - Object.keys(a[1].holders).length);
		let commonTokensData = '';
		if(commonTokens.length > 0) {
			commonTokens.slice(0, 10).forEach(([ mint, data ], index) => {
				const holdersCount = Object.keys(data.holders).length;
				commonTokensData += `\n${ index + 1 }. ${ data.symbol } (${ holdersCount }/${ addresses.length } wallets):`;
				Object.entries(data.holders).forEach(([ address, holdings ]) => {
					commonTokensData += `\n   - ${ addressNames[address] }: ${ Number(holdings.amount)
						.toLocaleString() } ($${ Number(holdings.usdValue) })`;
				});
			});
		} else {
			commonTokensData = '\nNo common tokens found between addresses';
		}
		return {
			content: [ {
				type: 'text',
				text: `Cross-analysis of ${ addresses.length } addresses:
        
Common tokens:${ commonTokensData }`,
			} ],
		};
	} catch(error) {
		logger.error({ error: error.message }, 'Error in cross analysis');
		const mcpError = new Error(`Error in cross analysis: ${ error.message }`);
		mcpError.code = -32000;
		throw mcpError;
	}
}

app.get('/api-docs', (req, res) => {
	const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>MCP Solana Analytics - Powered by Vybe API</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; line-height: 1.6; }
        h1 { color: #9945FF; margin-bottom: 10px; }
        h2 { color: #14F195; margin-top: 40px; margin-bottom: 10px; border-bottom: 1px solid #ddd; padding-bottom: 5px; }
        h3 { color: #00C2FF; margin-top: 25px; }
        pre { background-color: #f5f5f5; padding: 15px; border-radius: 5px; overflow-x: auto; font-size: 14px; }
        .endpoint { color: #0066cc; font-family: monospace; }
        .method { font-weight: bold; margin-top: 20px; }
        .category { margin-top: 40px; }
        .example { margin-top: 10px; margin-bottom: 30px; }
        .param { margin-left: 20px; }
        .param-name { font-weight: bold; color: #555; }
        .note { background-color: #ffffcc; padding: 10px; border-left: 4px solid #ffcc00; margin: 20px 0; }
      </style>
    </head>
    <body>
      <h1>MCP Solana Analytics - Powered by Vybe API</h1>
      <p>This Model Context Protocol (MCP) server provides access to Solana on-chain data and analytics through the Vybe API. It allows language models to access detailed information about wallets, tokens, NFTs, programs, and blockchain activity.</p>
      <div class="note">
        <strong>Authentication required:</strong> All requests must include the <code>x-api-key</code> header with your API key.
      </div>
      <h2>Endpoint</h2>
      <p class="endpoint">POST /mcp</p>
      <h2>Wallet Analysis Methods</h2>
      <div class="method">solana_wallet_overview</div>
      <p>Gets a general overview of a Solana wallet, including total value, tokens, and NFTs.</p>
      <div class="param"><span class="param-name">address</span> - Solana wallet address</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_wallet_overview",
  "params": { "address": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" },
  "id": 1
}</pre></div>
      <div class="method">solana_wallet_tokens</div>
      <p>Lists SPL tokens in a Solana wallet.</p>
      <div class="param"><span class="param-name">address</span> - Solana wallet address</div>
      <div class="param"><span class="param-name">include_no_price</span> - (Optional) Include tokens without price data (default: false)</div>
      <div class="param"><span class="param-name">limit</span> - (Optional) Maximum number of results (default: 100)</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_wallet_tokens",
  "params": { "address": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "include_no_price": true, "limit": 50 },
  "id": 1
}</pre></div>
      <div class="method">solana_wallet_nfts</div>
      <p>Lists NFTs in a Solana wallet.</p>
      <div class="param"><span class="param-name">address</span> - Solana wallet address</div>
      <div class="param"><span class="param-name">include_no_price</span> - (Optional) Include NFTs without price data (default: false)</div>
      <div class="param"><span class="param-name">limit</span> - (Optional) Maximum number of results (default: 100)</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_wallet_nfts",
  "params": { "address": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "include_no_price": true },
  "id": 1
}</pre></div>
      <div class="method">solana_wallet_pnl</div>
      <p>Analyzes wallet trading performance (Profit and Loss).</p>
      <div class="param"><span class="param-name">address</span> - Solana wallet address</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_wallet_pnl",
  "params": { "address": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" },
  "id": 1
}</pre></div>
      <h2>Token and Price Methods</h2>
      <div class="method">solana_token_details</div>
      <p>Gets detailed information about a Solana token.</p>
      <div class="param"><span class="param-name">mint_address</span> - Token mint address</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_token_details",
  "params": { "mint_address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  "id": 1
}</pre></div>
      <div class="method">solana_token_price</div>
      <p>Gets the current price of a Solana token.</p>
      <div class="param"><span class="param-name">mint_address</span> - (Optional) Token mint address</div>
      <div class="param"><span class="param-name">symbol</span> - (Optional) Token symbol (used if mint_address not provided or for specific cases like SOL)</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_token_price",
  "params": { "symbol": "SOL" },
  "id": 1
}</pre></div>
      <div class="method">solana_token_ohlc</div>
      <p>Gets OHLC (Open, High, Low, Close) data for a token.</p>
      <div class="param"><span class="param-name">mint_address</span> - Token mint address</div>
      <div class="param"><span class="param-name">resolution</span> - (Optional) Time resolution ('1m', '1h', '1d', etc.) (default: '1d')</div>
      <div class="param"><span class="param-name">limit</span> - (Optional) Number of data points (default: 7)</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_token_ohlc",
  "params": { "mint_address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "resolution": "1d", "limit": 14 },
  "id": 1
}</pre></div>
      <div class="method">solana_token_holders</div>
      <p>Lists the top holders of a token.</p>
      <div class="param"><span class="param-name">mint_address</span> - Token mint address</div>
      <div class="param"><span class="param-name">limit</span> - (Optional) Maximum number of holders to list (default: 10)</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_token_holders",
  "params": { "mint_address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "limit": 5 },
  "id": 1
}</pre></div>
      <h2>Program (dApp) Methods</h2>
      <div class="method">solana_program_details</div>
      <p>Gets detailed information about a Solana program.</p>
      <div class="param"><span class="param-name">program_id</span> - Solana program ID</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_program_details",
  "params": { "program_id": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" },
  "id": 1
}</pre></div>
      <div class="method">solana_program_metrics</div>
      <p>Gets activity metrics for a Solana program.</p>
      <div class="param"><span class="param-name">program_id</span> - Solana program ID</div>
      <div class="param"><span class="param-name">range</span> - (Optional) Time range ('1h', '24h', '7d', '30d') (default: '7d')</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_program_metrics",
  "params": { "program_id": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "range": "30d" },
  "id": 1
}</pre></div>
      <div class="method">solana_program_users</div>
      <p>Lists the most active users of a Solana program.</p>
      <div class="param"><span class="param-name">program_id</span> - Solana program ID</div>
      <div class="param"><span class="param-name">days</span> - (Optional) Number of past days to analyze (default: 7)</div>
      <div class="param"><span class="param-name">limit</span> - (Optional) Maximum number of users to list (default: 10)</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_program_users",
  "params": { "program_id": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "days": 30, "limit": 20 },
  "id": 1
}</pre></div>
      <h2>Transaction Methods</h2>
      <div class="method">solana_token_transfers</div>
      <p>Lists recent transfers of a token.</p>
      <div class="param"><span class="param-name">mint_address</span> - Token mint address</div>
      <div class="param"><span class="param-name">limit</span> - (Optional) Maximum number of transfers to list (default: 10)</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_token_transfers",
  "params": { "mint_address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "limit": 5 },
  "id": 1
}</pre></div>
      <div class="method">solana_trades</div>
      <p>Lists recent trades of a token.</p>
      <div class="param"><span class="param-name">mint_address</span> - Token mint address</div>
      <div class="param"><span class="param-name">limit</span> - (Optional) Maximum number of trades to list (default: 10)</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_trades",
  "params": { "mint_address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "limit": 5 },
  "id": 1
}</pre></div>
      <h2>Advanced Analysis Methods</h2>
      <div class="method">solana_whale_movements</div>
      <p>Tracks large token transfers (whale movements).</p>
      <div class="param"><span class="param-name">min_usd_amount</span> - (Optional) Minimum USD value of transfers (default: 10000)</div>
      <div class="param"><span class="param-name">limit</span> - (Optional) Maximum number of movements to list (default: 10)</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_whale_movements",
  "params": { "min_usd_amount": 50000, "limit": 5 },
  "id": 1
}</pre></div>
      <div class="method">solana_market_sentiment</div>
      <p>Analyzes current market sentiment based on program activity and token metrics.</p>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_market_sentiment",
  "params": {},
  "id": 1
}</pre></div>
      <div class="method">solana_network_activity</div>
      <p>Gets overall network activity metrics for Solana.</p>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_network_activity",
  "params": {},
  "id": 1
}</pre></div>
      <div class="method">solana_cross_analysis</div>
      <p>Performs cross-analysis between multiple wallet addresses.</p>
      <div class="param"><span class="param-name">addresses</span> - Array of Solana wallet addresses to compare</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "solana_cross_analysis",
  "params": { "addresses": ["9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ"] },
  "id": 1
}</pre></div>
      <h2>Language Model Methods</h2>
      <div class="method">openai_generate</div>
      <p>Generates a response using OpenAI models.</p>
      <div class="param"><span class="param-name">prompt</span> - The prompt to send to OpenAI</div>
      <div class="param"><span class="param-name">model</span> - (Optional) OpenAI model to use (default: "gpt-4o")</div>
      <div class="param"><span class="param-name">max_tokens</span> - (Optional) Maximum tokens to generate (default: 1000)</div>
      <div class="param"><span class="param-name">session_id</span> - Session ID for context management</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "openai_generate",
  "params": { "prompt": "Analyze the impact of rising SOL prices on DeFi protocols.", "model": "gpt-4o", "max_tokens": 500, "session_id": "session-123456" },
  "id": 1
}</pre></div>
      <div class="method">anthropic_generate</div>
      <p>Generates a response using Anthropic Claude models.</p>
      <div class="param"><span class="param-name">prompt</span> - The prompt to send to Anthropic</div>
      <div class="param"><span class="param-name">model</span> - (Optional) Anthropic model to use (default: "claude-3-5-sonnet-20240620")</div>
      <div class="param"><span class="param-name">max_tokens</span> - (Optional) Maximum tokens to generate (default: 1000)</div>
      <div class="param"><span class="param-name">session_id</span> - Session ID for context management</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "anthropic_generate",
  "params": { "prompt": "Explain how Solana's architecture differs from Ethereum.", "model": "claude-3-5-sonnet-20240620", "max_tokens": 500, "session_id": "session-123456" },
  "id": 1
}</pre></div>
      <div class="method">clear_context</div>
      <p>Clears conversation context for a specific session.</p>
      <div class="param"><span class="param-name">session_id</span> - Session ID to clear context for</div>
      <div class="example"><pre>
{
  "jsonrpc": "2.0",
  "method": "clear_context",
  "params": { "session_id": "session-123456" },
  "id": 1
}</pre></div>
    </body>
    </html>
  `;
	res.send(html);
});

const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*', // Durante desarrollo. Para producción, especifica tus dominios
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key']
}));
// Reemplaza la configuración actual de helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-eval'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "via.placeholder.com", "*"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
    }
  }
}));




app.listen(PORT, () => {
	logger.info(`Solana On-Chain Analytics MCP server running on port ${ PORT }`);
});
