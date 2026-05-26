import { MCPClient } from '@mastra/mcp'
import { withRetry } from './retry.js'

/**
 * DeepWiki hosted MCP — public, no key. Surfaces implementation-level detail
 * from open-source codebases (read_wiki_structure, read_wiki_contents,
 * ask_question) so repo-agent can ground technical assertions in shipped code,
 * not docs. Mirrors the Exa client pattern.
 *
 * Docs: https://docs.devin.ai/work-with-devin/deepwiki-mcp
 */
const DEEPWIKI_MCP_URL = 'https://mcp.deepwiki.com/mcp'

export const deepwikiMcpClient = new MCPClient({
	id: 'deepwiki-mcp-client',
	timeout: 120_000,
	servers: {
		deepwiki: { url: new URL(DEEPWIKI_MCP_URL) }
	}
})

export async function getDeepwikiTools() {
	return await withRetry(() => deepwikiMcpClient.listTools(), { label: 'deepwiki' })
}
