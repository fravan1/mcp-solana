import fetch from 'node-fetch';
import WebSocket from 'ws';
import 'dotenv/config'; // Ensure dotenv is configured to load environment variables

/**
 * @fileoverview VybeService - Static class for interacting with the Vybe Network API (v2).
 * Provides methods for accessing Solana on-chain data including accounts, tokens,
 * programs, prices, and real-time data via WebSockets.
 *
 * **IMPORTANT:** This version automatically retrieves the API key from the
 * environment variable `process.env.VYBE_API_KEY`. Ensure this variable is set
 * in your Node.js environment.
 *
 * @version 1.1.0
 * @see https://docs.vybenetwork.com/ (Replace with actual documentation link if available)
 */

// Ensure you're in a Node.js environment
if(typeof process === 'undefined' || !process.env) {
	console.error('FATAL ERROR: \'process.env\' is not available. This class requires a Node.js environment to access environment variables for the API key.');
	// Depending on the context, you might throw an error or exit
	// throw new Error("VybeService requires a Node.js environment.");
}

/**
 * Represents the structure for wallet arrays used in POST requests.
 * @typedef {Array<string>} WalletAddresses
 */

/**
 * Represents the structure for filter objects used in WebSocket configuration.
 * @typedef {object} WebSocketFilterConfig
 * @property {Array<object>} [trades] - Filters for the trades stream. Empty array receives all. Omit to receive none.
 * @property {Array<object>} [transfers] - Filters for the transfers stream. Empty array receives all. Omit to receive none.
 * @property {Array<object>} [oraclePrices] - Filters for the Pyth oracle prices stream. Empty array receives all. Omit to receive none.
 * // Add other potential streams like NFT Events when available
 */

/**
 * @class VybeService
 * @description Provides static methods to interact with the Vybe Network API V2 for Solana data analysis.
 * Automatically uses the API key from the `process.env.VYBE_API_KEY` environment variable.
 * @see https://alpha.vybenetwork.com/api-plans
 * @see https://alpha.vybenetwork.com/dashboard/api-management
 */
class VybeService {

	/**
	 * The base URL for the Vybe API V2.
	 * Confirm the exact URL from your Vybe API dashboard.
	 * @type {string}
	 * @private
	 * @static
	 */
	static _BASE_URL = 'https://api.vybenetwork.xyz'; // Example URL, verify this!

	/**
	 * The base URL for the Vybe WebSocket API.
	 * Confirm the exact URL from your Vybe API dashboard (available for Business/Premium plans).
	 * @type {string}
	 * @private
	 * @static
	 */
	static _WEBSOCKET_URL = 'wss://your-websocket-uri-here'; // Example URL, verify this!

	/**
	 * Retrieves the API key from the environment variable.
	 * @returns {string} The API key.
	 * @throws {Error} If the VYBE_API_KEY environment variable is not set.
	 * @private
	 * @static
	 */
	static _getApiKey() {
		const apiKey = process.env.VYBE_API_KEY;
		if(!apiKey) {
			throw new Error('API Key Error: The \'VYBE_API_KEY\' environment variable is not set.');
		}
		return apiKey;
	}

	/**
	 * Internal helper method to make authenticated requests to the Vybe API.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} path - The API endpoint path (e.g., '/accounts/known-accounts').
	 * @param {string} [method='GET'] - The HTTP method (GET, POST).
	 * @param {object|null} [queryParams=null] - Object containing query parameters.
	 * @param {object|null} [body=null] - Object containing the request body for POST requests.
	 * @returns {Promise<object>} A promise that resolves with the JSON response data.
	 * @throws {Error} If the network request fails, the API returns an error status, or the API key is missing.
	 * @private
	 * @static
	 */
	static async _request(path, method = 'GET', queryParams = null, body = null) {
		const apiKey = this._getApiKey(); // Get API key or throw error
		const url = new URL(this._BASE_URL + path);

		if(queryParams) {
			Object.keys(queryParams).forEach(key => {
				if(queryParams[key] !== undefined && queryParams[key] !== null) {
					url.searchParams.append(key, queryParams[key]);
				}
			});
		}

		const options = {
			method: method,
			headers: {
				'Content-Type': 'application/json',
				'X-API-Key': apiKey,
			},
		};

		if(body && method === 'POST') {
			options.body = JSON.stringify(body);
		}

		try {
			const response = await fetch(url.toString(), options);

			if(!response.ok) {
				let errorBody;
				try {
					errorBody = await response.json();
				} catch(e) {
					errorBody = await response.text();
				}
				throw new Error(`API Error: ${ response.status } ${ response.statusText } - ${ JSON.stringify(errorBody) }`);
			}

			if(response.status === 204) {
				return {};
			}

			return await response.json();
		} catch(error) {
			// Include the original error message if available
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`Vybe API request failed for path ${ path }: ${ errorMessage }`);
			// Re-throw a potentially more informative error or the original
			throw new Error(`Vybe API request failed for path ${ path }: ${ errorMessage }`);
		}
	}

	/**
	 * Retrieves comprehensive analysis of a wallet's trading performance (PnL).
	 */
	static getWalletPnl(ownerAddress, params = {}) {
		if(!ownerAddress) {
			throw new Error('ownerAddress parameter is required to get wallet PnL.');
		}
		return this._request(`/account/pnl/${ ownerAddress }`, 'GET', params);
	}

	/**
	 * Retrieves a ranked list of Solana programs.
	 */
	static getProgramRanking(params = {}) {
		return this._request('/program/ranking', 'GET', params);
	}

	// --- Account Endpoints ---

	/**
	 * Retrieve a categorized list of labeled Solana accounts.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {object} [params={}] - Query parameters.
	 * @param {string} [params.ownerAddress] - Filter by owner address.
	 * @param {string} [params.name] - Filter by account name label.
	 * @param {string} [params.labels] - Filter by comma-separated labels (e.g., 'CEX,DEFI').
	 * @param {string} [params.entityName] - Filter by entity name label.
	 * @param {string} [params.entityId] - Filter by entity ID label.
	 * @param {string} [params.sortByAsc] - Field to sort by ascending.
	 * @param {string} [params.sortByDesc] - Field to sort by descending.
	 * @returns {Promise<object>} A promise resolving to the list of known accounts.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_known_accounts
	 */
	static getKnownAccounts(params = {}) {
		return this._request('/account/known-accounts', 'GET', params);
	}

	/**
	 * Obtain NFT balances for a single provided account address.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} ownerAddress - The Solana wallet address.
	 * @param {object} [params={}] - Query parameters.
	 * @param {boolean} [params.includeNoPriceBalance] - Include NFTs without price data.
	 * @param {string} [params.sortByAsc] - Field to sort by ascending.
	 * @param {string} [params.sortByDesc] - Field to sort by descending.
	 * @param {number} [params.limit] - Number of results per page.
	 * @param {number} [params.page] - Page number.
	 * @returns {Promise<object>} A promise resolving to the NFT balances.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_wallet_nfts
	 */
	static getWalletNfts(ownerAddress, params = {}) {
		if(!ownerAddress) throw new Error('ownerAddress parameter is required.');
		return this._request(`/account/nft-balance/${ ownerAddress }`, 'GET', params);
	}

	/**
	 * Get NFT balances for multiple account addresses. (Requires Developer plan or higher for >1 wallet?)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {WalletAddresses} wallets - An array of Solana wallet addresses.
	 * @param {object} [params={}] - Query parameters and body options combined.
	 * @param {boolean} [params.includeNoPriceBalance] - Include NFTs without price data.
	 * @param {number} [params.limit] - Number of results per page.
	 * @param {number} [params.page] - Page number.
	 * @param {string} [params.sortByAsc] - Field to sort by ascending.
	 * @param {string} [params.sortByDesc] - Field to sort by descending.
	 * @returns {Promise<object>} A promise resolving to the NFT balances for the specified wallets.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/post_wallet_nfts_many
	 */
	static postWalletNftsMany(wallets, params = {}) {
		if(!wallets || !Array.isArray(wallets) || wallets.length === 0) {
			throw new Error('wallets parameter (array of strings) is required.');
		}
		const { includeNoPriceBalance, limit, page, sortByAsc, sortByDesc } = params;
		const queryParams = { includeNoPriceBalance, limit, page, sortByAsc, sortByDesc };
		const body = { wallets };
		return this._request('/account/nft-balances', 'POST', queryParams, body);
	}

	/**
	 * Retrieve daily SPL token balances for a given account address in time-series format. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} ownerAddress - The Solana wallet address.
	 * @param {object} [params={}] - Query parameters.
	 * @param {number} [params.days] - Number of past days of data to retrieve (check API docs for limits).
	 * @returns {Promise<object>} A promise resolving to the time-series token balances.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_wallet_tokens_ts
	 */
	static getWalletTokensTimeSeries(ownerAddress, params = {}) {
		if(!ownerAddress) throw new Error('ownerAddress parameter is required.');
		return this._request(`/account/token-balance-ts/${ ownerAddress }`, 'GET', params);
	}

	/**
	 * Get SPL token balances for a single provided account address.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} ownerAddress - The Solana wallet address.
	 * @param {object} [params={}] - Query parameters.
	 * @param {boolean} [params.includeNoPriceBalance] - Include tokens without price data.
	 * @param {string} [params.sortByAsc] - Field to sort by ascending.
	 * @param {string} [params.sortByDesc] - Field to sort by descending.
	 * @param {number} [params.limit] - Number of results per page.
	 * @param {number} [params.page] - Page number.
	 * @returns {Promise<object>} A promise resolving to the SPL token balances.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_wallet_tokens
	 */
	static getWalletTokens(ownerAddress, params = {}) {
		if(!ownerAddress) throw new Error('ownerAddress parameter is required.');
		return this._request(`/account/token-balance/${ ownerAddress }`, 'GET', params);
	}

	/**
	 * Get SPL token balances for multiple account addresses. (Requires Developer plan or higher?)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {WalletAddresses} wallets - An array of Solana wallet addresses.
	 * @param {object} [params={}] - Query parameters and body options combined.
	 * @param {boolean} [params.includeNoPriceBalance] - Include tokens without price data.
	 * @param {number} [params.limit] - Number of results per page.
	 * @param {number} [params.page] - Page number.
	 * @param {string} [params.sortByAsc] - Field to sort by ascending.
	 * @param {string} [params.sortByDesc] - Field to sort by descending.
	 * @returns {Promise<object>} A promise resolving to the SPL token balances for the specified wallets.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/post_wallet_tokens_many
	 */
	static postWalletTokensMany(wallets, params = {}) {
		if(!wallets || !Array.isArray(wallets) || wallets.length === 0) {
			throw new Error('wallets parameter (array of strings) is required.');
		}
		const { includeNoPriceBalance, limit, page, sortByAsc, sortByDesc } = params;
		const queryParams = { includeNoPriceBalance, limit, page, sortByAsc, sortByDesc };
		const body = { wallets };
		return this._request('/account/token-balances', 'POST', queryParams, body);
	}

	/**
	 * Retrieve daily SPL token balances for multiple account addresses in time-series format. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {WalletAddresses} wallets - An array of Solana wallet addresses.
	 * @param {object} [params={}] - Query parameters and body options combined.
	 * @param {number} [params.days] - Number of past days of data to retrieve.
	 * @returns {Promise<object>} A promise resolving to the time-series token balances for the specified wallets.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/post_wallet_tokens_ts_many
	 */
	static postWalletTokensTimeSeriesMany(wallets, params = {}) {
		if(!wallets || !Array.isArray(wallets) || wallets.length === 0) {
			throw new Error('wallets parameter (array of strings) is required.');
		}
		const { days } = params;
		const queryParams = { days };
		const body = { wallets };
		return this._request('/account/token-balances-ts', 'POST', queryParams, body);
	}

	// --- Program Endpoints ---

	/**
	 * Get a categorized list of labeled programs.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {object} [params={}] - Query parameters.
	 * @param {string} [params.programId] - Filter by program ID.
	 * @param {string} [params.name] - Filter by program name label.
	 * @param {string} [params.labels] - Filter by comma-separated labels.
	 * @param {string} [params.entityName] - Filter by entity name label.
	 * @param {string} [params.entityId] - Filter by entity ID label.
	 * @param {string} [params.sortByAsc] - Field to sort by ascending.
	 * @param {string} [params.sortByDesc] - Field to sort by descending.
	 * @returns {Promise<object>} A promise resolving to the list of known programs.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_known_program_accounts
	 */
	static getKnownProgramAccounts(params = {}) {
		return this._request('/program/known-program-accounts', 'GET', params);
	}

	/**
	 * Get program details including metrics for a specific program ID.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} programID - The Program ID.
	 * @returns {Promise<object>} A promise resolving to the program details.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_program
	 */
	static getProgramDetails(programID) {
		if(!programID) throw new Error('programID parameter is required.');
		return this._request(`/program/${ programID }`, 'GET');
	}

	/**
	 * Get active users with instruction/transaction counts for a program. (Requires Developer plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} programId - The Program ID.
	 * @param {object} [params={}] - Query parameters.
	 * @param {number} [params.days] - Number of past days (1-30).
	 * @param {number} [params.limit] - Limit number of results.
	 * @param {string} [params.sortByAsc] - Field to sort by ascending.
	 * @param {string} [params.sortByDesc] - Field to sort by descending.
	 * @returns {Promise<object>} A promise resolving to the active user data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_program_active_users
	 */
	static getProgramActiveUsers(programId, params = {}) {
		if(!programId) throw new Error('programId parameter is required.');
		return this._request(`/program/${ programId }/active-users`, 'GET', params);
	}

	/**
	 * Get time series data for active users of a program. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} programId - The Program ID.
	 * @param {object} params - Query parameters.
	 * @param {string} params.range - Time range (e.g., '1h', '24h', '7d', '30d'). Required.
	 * @returns {Promise<object>} A promise resolving to the time series data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_program_active_users_count
	 */
	static getProgramActiveUsersTimeSeries(programId, params) {
		if(!programId) throw new Error('programId parameter is required.');
		if(!params || !params.range) throw new Error('params.range is required.');
		return this._request(`/program/${ programId }/active-users-ts`, 'GET', params);
	}

	/**
	 * Get time series data for instruction counts of a program. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} programId - The Program ID.
	 * @param {object} params - Query parameters.
	 * @param {string} params.range - Time range (e.g., '1h', '24h', '7d', '30d'). Required.
	 * @returns {Promise<object>} A promise resolving to the time series data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_program_instructions_count
	 */
	static getProgramInstructionsCountTimeSeries(programId, params) {
		if(!programId) throw new Error('programId parameter is required.');
		if(!params || !params.range) throw new Error('params.range is required.');
		return this._request(`/program/${ programId }/instructions-count-ts`, 'GET', params);
	}

	/**
	 * Get time series data for transaction counts of a program. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} programId - The Program ID.
	 * @param {object} params - Query parameters.
	 * @param {string} params.range - Time range (e.g., '1h', '24h', '7d', '30d'). Required.
	 * @returns {Promise<object>} A promise resolving to the time series data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_program_transactions_count
	 */
	static getProgramTransactionsCountTimeSeries(programId, params) {
		if(!programId) throw new Error('programId parameter is required.');
		if(!params || !params.range) throw new Error('params.range is required.');
		return this._request(`/program/${ programId }/transactions-count-ts`, 'GET', params);
	}

	/**
	 * Get Total Value Locked (TVL) time series data for a program. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} programId - The Program ID.
	 * @param {object} params - Query parameters.
	 * @param {string} params.resolution - Time resolution ('1h', '1d', '1w', '1m', '1y'). Required.
	 * @returns {Promise<object>} A promise resolving to the TVL time series data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_program_tvl
	 */
	static getProgramTvlTimeSeries(programId, params) {
		if(!programId) throw new Error('programId parameter is required.');
		if(!params || !params.resolution) throw new Error('params.resolution is required.');
		return this._request(`/program/${ programId }/tvl`, 'GET', params);
	}

	/**
	 * Get a list of all Solana programs with IDLs (Interface Description Languages).
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {object} [params={}] - Query parameters.
	 * @param {string} [params.labels] - Filter by comma-separated labels.
	 * @param {number} [params.limit] - Number of results per page.
	 * @param {number} [params.page] - Page number.
	 * @param {string} [params.sortByAsc] - Field to sort by ascending.
	 * @param {string} [params.sortByDesc] - Field to sort by descending.
	 * @returns {Promise<object>} A promise resolving to the list of programs.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_programs_list
	 */
	static getProgramsList(params = {}) {
		return this._request('/programs', 'GET', params);
	}

	// --- Price Endpoints ---

	/**
	 * Get all available market IDs queryable via the Vybe API for a given program.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {object} params - Query parameters.
	 * @param {string} params.programId - The program ID (DEX/AMM). Required.
	 * @param {number} [params.page] - Page number.
	 * @param {number} [params.limit] - Number of results per page.
	 * @returns {Promise<object>} A promise resolving to the list of market IDs.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_markets
	 */
	static getPriceMarkets(params) {
		if(!params || !params.programId) throw new Error('params.programId is required.');
		return this._request('/price/markets', 'GET', params);
	}

	/**
	 * Get all available DEXs' and AMMs' programs used for trades and prices.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @returns {Promise<object>} A promise resolving to the list of DEX/AMM programs.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_programs
	 */
	static getPricePrograms() {
		return this._request('/price/programs', 'GET');
	}

	/**
	 * Retrieve a list of all Pyth oracle price accounts with corresponding product accounts and symbols.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {object} [params={}] - Query parameters.
	 * @param {string} [params.productId] - Filter by Pyth product ID.
	 * @param {string} [params.priceFeedId] - Filter by Pyth price feed ID.
	 * @returns {Promise<object>} A promise resolving to the list of Pyth accounts.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_pyth_price_product_pairs
	 */
	static getPythAccounts(params = {}) {
		return this._request('/price/pyth-accounts', 'GET', params);
	}

	/**
	 * Retrieve trade price (OHLCV) for a base/quote token pair. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} baseMintAddress - The mint address of the base token.
	 * @param {string} quoteMintAddress - The mint address of the quote token.
	 * @param {object} [params={}] - Query parameters.
	 * @param {string} [params.programId] - Filter by specific DEX/AMM program ID.
	 * @param {string} [params.resolution] - Time interval (e.g., '1m', '1h', '1d'). Check docs for options.
	 * @param {number} [params.timeStart] - Start timestamp (Unix seconds).
	 * @param {number} [params.timeEnd] - End timestamp (Unix seconds).
	 * @param {number} [params.page] - Page number.
	 * @param {number} [params.limit] - Number of results per page.
	 * @returns {Promise<object>} A promise resolving to the OHLCV data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_pair_trade_ohlcv_program
	 */
	static getPairTradeOhlcv(baseMintAddress, quoteMintAddress, params = {}) {
		if(!baseMintAddress) throw new Error('baseMintAddress parameter is required.');
		if(!quoteMintAddress) throw new Error('quoteMintAddress parameter is required.');
		const path = `/price/${ baseMintAddress }+${ quoteMintAddress }/pair-ohlcv`;
		return this._request(path, 'GET', params);
	}

	/**
	 * Get OHLCV price for a unique trading pair or liquidity pool market ID. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} marketId - The unique market ID.
	 * @param {object} [params={}] - Query parameters.
	 * @param {string} [params.resolution] - Time interval (e.g., '1m', '1h', '1d'). Check docs for options.
	 * @param {number} [params.timeStart] - Start timestamp (Unix seconds).
	 * @param {number} [params.timeEnd] - End timestamp (Unix seconds).
	 * @param {number} [params.page] - Page number.
	 * @param {number} [params.limit] - Number of results per page.
	 * @returns {Promise<object>} A promise resolving to the OHLCV data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_market_filtered_ohlcv
	 */
	static getMarketOhlcv(marketId, params = {}) {
		if(!marketId) throw new Error('marketId parameter is required.');
		return this._request(`/price/${ marketId }/market-ohlcv`, 'GET', params);
	}

	/**
	 * Retrieve OHLC for a token's USD price based on aggregated trades.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} mintAddress - The token mint address.
	 * @param {object} [params={}] - Query parameters.
	 * @param {string} [params.resolution] - Time interval (e.g., '1m', '1h', '1d'). Check docs for options.
	 * @param {number} [params.timeStart] - Start timestamp (Unix seconds).
	 * @param {number} [params.timeEnd] - End timestamp (Unix seconds).
	 * @param {number} [params.limit] - Number of results per page.
	 * @param {number} [params.page] - Page number.
	 * @returns {Promise<object>} A promise resolving to the token OHLC data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_token_trade_ohlc
	 */
	static getTokenOhlc(mintAddress, params = {}) {
		if(!mintAddress) throw new Error('mintAddress parameter is required.');
		return this._request(`/price/${ mintAddress }/token-ohlcv`, 'GET', params);
	}

	/**
	 * Access up-to-date pricing information through a Pyth Price feed ID.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} priceFeedId - The Pyth Price Feed ID.
	 * @returns {Promise<object>} A promise resolving to the current Pyth price data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_pyth_price
	 */
	static getPythPrice(priceFeedId) {
		if(!priceFeedId) throw new Error('priceFeedId parameter is required.');
		return this._request(`/price/${ priceFeedId }/pyth-price`, 'GET');
	}

	/**
	 * Retrieve OHLC data from a Pyth Oracle price feed ID.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} priceFeedId - The Pyth Price Feed ID.
	 * @param {object} [params={}] - Query parameters.
	 * @param {string} [params.resolution] - Time interval (e.g., '1m', '1h', '1d'). Check docs for options.
	 * @param {number} [params.timeStart] - Start timestamp (Unix seconds).
	 * @param {number} [params.timeEnd] - End timestamp (Unix seconds).
	 * @param {number} [params.limit] - Number of results per page.
	 * @param {number} [params.page] - Page number.
	 * @returns {Promise<object>} A promise resolving to the Pyth OHLC data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_pyth_price_ohlc
	 */
	static getPythPriceOhlc(priceFeedId, params = {}) {
		if(!priceFeedId) throw new Error('priceFeedId parameter is required.');
		return this._request(`/price/${ priceFeedId }/pyth-price-ohlc`, 'GET', params);
	}

	/**
	 * Access real-time and historical oracle prices (time series) of a Pyth Price feed ID.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} priceFeedId - The Pyth Price Feed ID.
	 * @param {object} [params={}] - Query parameters.
	 * @param {string} [params.resolution] - Time interval (e.g., '1m', '1h', '1d'). Check docs for options.
	 * @param {number} [params.timeStart] - Start timestamp (Unix seconds).
	 * @param {number} [params.timeEnd] - End timestamp (Unix seconds).
	 * @param {number} [params.limit] - Number of results per page.
	 * @param {number} [params.page] - Page number.
	 * @returns {Promise<object>} A promise resolving to the Pyth price time series data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_pyth_price_ts
	 */
	static getPythPriceTimeSeries(priceFeedId, params = {}) {
		if(!priceFeedId) throw new Error('priceFeedId parameter is required.');
		return this._request(`/price/${ priceFeedId }/pyth-price-ts`, 'GET', params);
	}

	/**
	 * Retrieve metadata for a specific product using its Product ID from the Pyth network.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} productId - The Pyth Product ID.
	 * @returns {Promise<object>} A promise resolving to the Pyth product metadata.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_pyth_product
	 */
	static getPythProduct(productId) {
		if(!productId) throw new Error('productId parameter is required.');
		return this._request(`/price/${ productId }/pyth-product`, 'GET');
	}

	// --- Token Endpoints ---

	/**
	 * Retrieves a comprehensive list of instruction names derived from discriminants.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {object} [params={}] - Query parameters.
	 * @param {string} [params.ixName] - Filter by instruction name.
	 * @param {string} [params.callingInstructions] - Filter by calling instruction.
	 * @param {string} [params.callingProgram] - Filter by calling program ID.
	 * @param {string} [params.programName] - Filter by program name label.
	 * @returns {Promise<object>} A promise resolving to the list of instruction names.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_token_instruction_names
	 */
	static getTokenInstructionNames(params = {}) {
		return this._request('/token/instruction-names', 'GET', params);
	}

	/**
	 * Access trade data executed within programs. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * Default window is 14 days if timeStart/timeEnd omitted.
	 * @param {object} [params={}] - Query parameters.
	 * @param {string} [params.programId] - Filter by DEX/AMM program ID.
	 * @param {string} [params.baseMintAddress] - Filter by base token mint.
	 * @param {string} [params.quoteMintAddress] - Filter by quote token mint.
	 * @param {string} [params.mintAddress] - Filter by either base or quote token mint.
	 * @param {string} [params.marketId] - Filter by market ID.
	 * @param {string} [params.authorityAddress] - Filter by trade authority address.
	 * @param {string} [params.resolution] - Time resolution (check docs).
	 * @param {number} [params.timeStart] - Start timestamp (Unix seconds).
	 * @param {number} [params.timeEnd] - End timestamp (Unix seconds).
	 * @param {number} [params.page] - Page number.
	 * @param {number} [params.limit] - Number of results per page.
	 * @param {string} [params.sortByAsc] - Field to sort by ascending.
	 * @param {string} [params.sortByDesc] - Field to sort by descending.
	 * @param {string} [params.feePayer] - Filter by fee payer address.
	 * @returns {Promise<object>} A promise resolving to the trade data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_trade_data_program
	 */
	static getTokenTrades(params = {}) {
		return this._request('/token/trades', 'GET', params);
	}

	/**
	 * Retrieve token transfer transactions with filtering options. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {object} [params={}] - Query parameters.
	 * @param {string} [params.mintAddress] - Filter by token mint address.
	 * @param {string} [params.signature] - Filter by transaction signature.
	 * @param {string} [params.callingProgram] - Filter by the program initiating the transfer.
	 * @param {string} [params.walletAddress] - Filter by sender OR receiver wallet address.
	 * @param {string} [params.senderTokenAccount] - Filter by sender token account address.
	 * @param {string} [params.senderAddress] - Filter by sender wallet address.
	 * @param {string} [params.receiverTokenAccount] - Filter by receiver token account address.
	 * @param {string} [params.receiverAddress] - Filter by receiver wallet address.
	 * @param {string} [params.feePayer] - Filter by fee payer address.
	 * @param {number} [params.minUsdAmount] - Minimum transfer value in USD.
	 * @param {number} [params.maxUsdAmount] - Maximum transfer value in USD.
	 * @param {number} [params.timeStart] - Start timestamp (Unix seconds).
	 * @param {number} [params.timeEnd] - End timestamp (Unix seconds).
	 * @param {number} [params.page] - Page number.
	 * @param {number} [params.limit] - Number of results per page.
	 * @param {string} [params.sortByAsc] - Field to sort by ascending (e.g., 'blockTime').
	 * @param {string} [params.sortByDesc] - Field to sort by descending (e.g., 'blockTime').
	 * @returns {Promise<object>} A promise resolving to the token transfer data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_token_transfers
	 */
	static getTokenTransfers(params = {}) {
		return this._request('/token/transfers', 'GET', params);
	}

	/**
	 * Retrieves token details and 24h activity overview for a specific mint address.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} mintAddress - The token mint address.
	 * @returns {Promise<object>} A promise resolving to the token details.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_token_details
	 */
	static getTokenDetails(mintAddress) {
		if(!mintAddress) throw new Error('mintAddress parameter is required.');
		return this._request(`/token/${ mintAddress }`, 'GET');
	}

	/**
	 * Retrieves the top 1,000 token holders for a specific mint address. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * Data is updated every three hours.
	 * @param {string} mintAddress - The token mint address.
	 * @param {object} [params={}] - Query parameters.
	 * @param {number} [params.page] - Page number (for pagination within the top 1000).
	 * @param {number} [params.limit] - Number of results per page (max likely 1000 total).
	 * @returns {Promise<object>} A promise resolving to the list of top holders.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_top_holders
	 */
	static getTopTokenHolders(mintAddress, params = {}) {
		if(!mintAddress) throw new Error('mintAddress parameter is required.');
		return this._request(`/token/${ mintAddress }/top-holders`, 'GET', params);
	}

	/**
	 * Retrieves time series data of token holders count for a specific mint ID. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} mintId - The token mint address.
	 * @param {object} [params={}] - Query parameters.
	 * @param {number} [params.startTime] - Start timestamp (Unix seconds).
	 * @param {number} [params.endTime] - End timestamp (Unix seconds).
	 * @param {string} [params.interval] - Time interval (e.g., '1d', '1h'). Check docs.
	 * @param {number} [params.limit] - Limit number of data points.
	 * @param {number} [params.page] - Page number.
	 * @returns {Promise<object>} A promise resolving to the holders time series data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_token_holders_time_series
	 */
	static getTokenHoldersTimeSeries(mintId, params = {}) {
		if(!mintId) throw new Error('mintId parameter is required.');
		return this._request(`/token/${ mintId }/holders-ts`, 'GET', params);
	}

	/**
	 * Retrieves token volume in USD over a specified period for a specific mint ID. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} mintId - The token mint address.
	 * @param {object} [params={}] - Query parameters.
	 * @param {number} [params.startTime] - Start timestamp (Unix seconds).
	 * @param {number} [params.endTime] - End timestamp (Unix seconds).
	 * @param {string} [params.interval] - Time interval (e.g., '1d', '1h'). Check docs.
	 * @param {number} [params.limit] - Limit number of data points.
	 * @param {number} [params.page] - Page number.
	 * @returns {Promise<object>} A promise resolving to the volume time series data.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_token_volume_time_series
	 */
	static getTokenVolumeTimeSeries(mintId, params = {}) {
		if(!mintId) throw new Error('mintId parameter is required.');
		return this._request(`/token/${ mintId }/transfer-volume`, 'GET', params);
	}

	/**
	 * Retrieves a list of tracked tokens with sorting options.
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {object} [params={}] - Query parameters.
	 * @param {string} [params.sortByAsc] - Field to sort by ascending.
	 * @param {string} [params.sortByDesc] - Field to sort by descending.
	 * @param {number} [params.limit] - Number of results per page.
	 * @param {number} [params.page] - Page number.
	 * @returns {Promise<object>} A promise resolving to the list of tokens.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_tokens_summary
	 */
	static getTokensSummary(params = {}) {
		return this._request('/tokens', 'GET', params);
	}

	// --- NFT Collection Endpoints ---

	/**
	 * Get owners of NFTs within a specific collection address. (Requires Business plan or higher)
	 * Uses API key from `process.env.VYBE_API_KEY`.
	 * @param {string} collectionAddress - The address of the NFT collection.
	 * @param {object} [params={}] - Query parameters.
	 * @returns {Promise<object>} A promise resolving to the list of collection owners.
	 * @static
	 * @see https://docs.vybenetwork.com/reference/get_collection_owners
	 */
	static getNftCollectionOwners(collectionAddress, params = {}) {
		if(!collectionAddress) throw new Error('collectionAddress parameter is required.');
		return this._request(`/nft/collection-owners/${ collectionAddress }`, 'GET', params);
	}

	// --- WebSocket Interaction ---
	// Note: WebSockets require a Business or Premium subscription plan.
	// These methods help initiate and configure the connection. The caller manages the WebSocket object itself.

	/**
	 * Creates and initiates a WebSocket connection to the Vybe real-time data stream.
	 * **Requires a Business or Premium plan.**
	 * Uses API key from `process.env.VYBE_API_KEY` (must be a Business/Premium key).
	 * Remember to get your specific WebSocket URI from the Vybe dashboard.
	 * @param {object} callbacks - Callback functions for WebSocket events.
	 * @param {function} [callbacks.onOpen] - Called when the connection is established. Receives the WebSocket event.
	 * @param {function} [callbacks.onMessage] - Called when a message is received. Receives the WebSocket message event. Message data needs parsing (JSON.parse).
	 * @param {function} [callbacks.onError] - Called when an error occurs. Receives the WebSocket error event.
	 * @param {function} [callbacks.onClose] - Called when the connection is closed. Receives the WebSocket close event.
	 * @param {string} [websocketUri=VybeService._WEBSOCKET_URL] - The specific WebSocket URI provided by Vybe. Defaults to the class placeholder.
	 * @param {boolean} [enableReconnect=false] - Simple flag for basic reconnect logic example (implement robust reconnect separately).
	 * @returns {WebSocket} The WebSocket instance. The caller is responsible for managing this instance.
	 * @throws {Error} If the VYBE_API_KEY environment variable is not set.
	 * @static
	 * @see https://docs.vybenetwork.com/docs/connecting-to-websocket
	 */
	static createWebSocketConnection(callbacks, websocketUri = VybeService._WEBSOCKET_URL, enableReconnect = false) {
		// Dynamically import 'ws' only if in Node.js and needed
		const WebSocket = require('ws'); // Ensure 'ws' is installed (`npm install ws`)

		const apiKey = this._getApiKey(); // Get API key or throw error (Must be Business/Premium for WS)

		if(!websocketUri || websocketUri === 'wss://your-websocket-uri-here') {
			console.warn('WebSocket URI is not set or is using the placeholder. Get the correct URI from your Vybe dashboard.');
			// Consider throwing an error if a real URI is strictly required
			// throw new Error("WebSocket URI is required. Obtain it from your Vybe dashboard.");
		}

		const ws = new WebSocket(websocketUri, {
			headers: { 'X-API-Key': apiKey },
		});

		// Attach event listeners (same as before)
		ws.onopen = (event) => {
			console.log('Vybe WebSocket connection established.', event);
			if(callbacks.onOpen) callbacks.onOpen(event);
		};
		ws.onmessage = (messageEvent) => {
			if(callbacks.onMessage) callbacks.onMessage(messageEvent);
		};
		ws.onerror = (errorEvent) => {
			console.error('Vybe WebSocket error:', errorEvent);
			if(callbacks.onError) callbacks.onError(errorEvent);
			if(enableReconnect) {
				console.log('Attempting WebSocket reconnect...');
				setTimeout(() => VybeService.createWebSocketConnection(callbacks, websocketUri, enableReconnect), 5000);
			}
		};
		ws.onclose = (closeEvent) => {
			console.log('Vybe WebSocket connection closed:', closeEvent.code, closeEvent.reason);
			if(callbacks.onClose) callbacks.onClose(closeEvent);
			if(enableReconnect && !closeEvent.wasClean) {
				console.log('Attempting WebSocket reconnect...');
				setTimeout(() => VybeService.createWebSocketConnection(callbacks, websocketUri, enableReconnect), 5000);
			}
		};

		return ws;
	}

	/**
	 * Sends a filter configuration message to an active Vybe WebSocket connection.
	 * Use this after the 'open' event to specify which data streams and filters you need.
	 * Sending a new configuration updates the stream without reconnecting.
	 * @param {WebSocket} wsInstance - The active WebSocket instance returned by `createWebSocketConnection`.
	 * @param {WebSocketFilterConfig} filters - The filter configuration object.
	 * @static
	 * @see https://docs.vybenetwork.com/docs/filter-configuration
	 */
	static sendWebSocketConfigure(wsInstance, filters) {
		// Check if wsInstance is a valid WebSocket object from 'ws' library
		const WebSocket = require('ws'); // Make sure WebSocket is defined
		if(!wsInstance || !(wsInstance instanceof WebSocket) || wsInstance.readyState !== WebSocket.OPEN) {
			console.error('WebSocket is not open or not a valid instance. Cannot send configuration.');
			return;
		}
		if(!filters || typeof filters !== 'object') {
			throw new Error('Filters object is required.');
		}

		const configureMessage = JSON.stringify({
			type: 'configure',
			filters: filters,
		});

		try {
			wsInstance.send(configureMessage);
			console.log('Sent WebSocket configuration:', filters);
		} catch(error) {
			console.error('Failed to send WebSocket configuration:', error);
			throw error;
		}
	}

	// --- Network Graph Widget --- (No change needed, doesn't use API key)
	/**
	 * Generates the URL for embedding the Vybe Network Graph Widget in an iframe.
	 * @param {object} params - Configuration parameters for the widget.
	 * @param {string} params.address - The entity's public key (wallet, program, or token mint). Required.
	 * @param {'wallet' | 'program' | 'token'} params.entity - The type of the entity address. Required.
	 * @param {'program' | 'token' | 'wallet'} [params.connectionNode='program'] - How to display connections.
	 * @returns {string} The URL for the iframe src attribute.
	 * @static
	 * @see https://docs.vybenetwork.com/docs/network-graph
	 */
	static getNetworkGraphWidgetUrl(params) {
		if(!params || !params.address || !params.entity) {
			throw new Error('address and entity parameters are required for the Network Graph Widget.');
		}
		const baseUrl = 'https://widget.vybenetwork.com/network-graph';
		const urlParams = new URLSearchParams();
		urlParams.set('address', params.address);
		urlParams.set('entity', params.entity);
		if(params.connectionNode) {
			urlParams.set('connectionNode', params.connectionNode);
		}
		return `${ baseUrl }?${ urlParams.toString() }`;
	}

	// --- Informational Methods --- (No change needed)
	/** @static */
	static getBulkDataExportInfo() { /* ... unchanged ... */
		return 'Vybe Network\'s Bulk Data Export service provides historical Solana data for enterprise use. Access requires contacting Vybe via their Enterprise Bulk Data Export Request Form or support@vybenetwork.com. See: https://docs.vybenetwork.com/docs/bulk-data-export';
	}

	/** @static */
	static getApiKeyInfo() { /* ... unchanged ... */
		return 'To get a Vybe API Key, sign in to AlphaVybe (https://alpha.vybenetwork.com/api-plans) using a Solana wallet or social login. Navigate to your dashboard -> API Management to generate a free API key or manage subscriptions. Set the key in the \'VYBE_API_KEY\' environment variable for this class to use it. See: https://docs.vybenetwork.com/docs/getting-started';
	}

	/** @static */
	static getSubscriptionInfo() { /* ... unchanged ... */
		return 'Manage your Vybe API subscription via the AlphaVybe dashboard (https://alpha.vybenetwork.com/dashboard/api-management or https://alpha.vybenetwork.com/api-plans). Upgrades and downgrades are handled through Stripe. See: https://docs.vybenetwork.com/docs/upgrading-your-subscription';
	}

}

export default VybeService;
