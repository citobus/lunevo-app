const Anthropic = require('@anthropic-ai/sdk');

let _client;

function getAnthropicClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set in environment variables');
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/**
 * Send a message to Claude and return the text response.
 *
 * @param {object} options
 * @param {string} options.systemPrompt
 * @param {string} options.userMessage
 * @param {string} [options.model]       - defaults to claude-haiku-4-5-20251001
 * @param {number} [options.maxTokens]   - defaults to 1024
 * @param {number} [options.temperature] - defaults to 0.7
 * @returns {Promise<string>}
 */
async function sendMessage({ systemPrompt, userMessage, model, maxTokens = 1024, temperature = 0.7 }) {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model: model || process.env.DEFAULT_CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const block = response.content.find((b) => b.type === 'text');
  if (!block) throw new Error('Claude returned no text content');
  return block.text;
}

module.exports = { sendMessage };
