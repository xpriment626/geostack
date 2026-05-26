import { MCPClient } from '@mastra/mcp'
import { withRetry } from './retry.js'

/**
 * Exa hosted MCP. Free tier: 3 QPS / 150 calls per day, no key required.
 * We opt into the three search/fetch tools via ?tools=. If EXA_API_KEY is
 * set, pass it through for higher quota.
 */
const params = new URLSearchParams({
	tools: 'web_search_exa,web_fetch_exa,web_search_advanced_exa'
})
if (process.env.EXA_API_KEY) params.set('exaApiKey', process.env.EXA_API_KEY)

const EXA_MCP_URL = `https://mcp.exa.ai/mcp?${params.toString()}`

export const exaMcpClient = new MCPClient({
	id: 'exa-mcp-client',
	timeout: 60_000,
	servers: {
		exa: { url: new URL(EXA_MCP_URL) }
	}
})

export async function getExaTools() {
	return await withRetry(() => exaMcpClient.listTools(), { label: 'exa' })
}
