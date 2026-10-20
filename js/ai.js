// Reads receipts, PDFs and spoken notes with Claude and returns structured expense data.
// The API key belongs to the person using the app and never leaves their phone except to go to Anthropic.

import Anthropic from '../vendor/anthropic-sdk.mjs';
import { settings } from './settings.js';
import { blobToBase64, toISODate } from './util.js';

export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Most accurate', detail: 'Claude Opus 5.5 · about 2–3¢ per receipt' },
  { id: 'claude-sonnet-5-5', name: 'Balanced', detail: 'Claude Sonnet 5.5 · about 1¢ per receipt' },
  { id: 'claude-haiku-5-5', name: 'Lowest cost', detail: 'Claude Haiku 5.5 · under 0.1¢ per receipt' },
];

// Models that support server-side refusal fallbacks (Haiku has none).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

const UNCATEGORIZED = 'Uncategorized';

// How a failure should be handled by the queue.
export class AIError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'auth' | 'offline' | 'retry' | 'fatal'
  }
}

function client(apiKey) {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 120_000 });
}

export async function testApiKey(apiKey, model) {
  try {
    await client(apiKey).models.retrieve(model);
    return { ok: true };
  } catch (err) {
    const e = classify(err);
    return { ok: false, message: e.message };
  }
}

function buildSchema(categories) {
  const categoryField = categories.length
    ? { type: 'string', enum: [...categories, UNCATEGORIZED] }
    : { type: 'string' };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['is_expense', 'not_expense_reason', 'expenses'],
    properties: {
      is_expense: { type: 'boolean' },
      not_expense_reason: { type: 'string' },
      expenses: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'date', 'vendor', 'description', 'total', 'subtotal', 'tax', 'tip', 'currency',
            'category', 'payment_method', 'notes', 'confidence', 'review_reasons',
          ],
          properties: {
            date: { type: 'string', format: 'date' },
            vendor: { type: 'string' },
            description: { type: 'string' },
            total: { type: 'number' },
            subtotal: { type: 'number' },
            tax: { type: 'number' },
            tip: { type: 'number' },
            currency: { type: 'string', description: 'ISO 4217 code' },
            category: categoryField,
            payment_method: { type: 'string' },
            notes: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            review_reasons: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };
}

function buildSystemPrompt(s) {
  const categoryLine = s.categories.length
    ? `Allowed categories: ${s.categories.join('; ')}. Use "${UNCATEGORIZED}" only when none fit.`
    : 'The user has no category list yet; use a short, conventional bookkeeping category.';
  const paymentLine = s.paymentMethods.length
    ? `The user's payment methods: ${s.paymentMethods.join('; ')}.`
    : 'The user has not listed payment methods.';
  const extra = s.ai.instructions?.trim()
    ? `\n\nThe user's own instructions (follow them unless they conflict with the format):\n${s.ai.instructions.trim()}`
    : '';

  return `You turn receipts, invoices and spoken descriptions of purchases into clean expense records for bookkeeping.

Return one record per separate purchase. A receipt is one record even with many line items. A spoken note may describe several purchases; return one record for each.

Fields:
- date: purchase date as YYYY-MM-DD. Resolve relative dates ("yesterday", "last Friday") against the date the entry was recorded, which is given with each entry. If no date is shown or stated, use the recorded date and add a review reason saying so.
- vendor: the business name as a person would write it ("Home Depot", not "THE HOME DEPOT #0412").
- description: what was bought, in a few plain words.
- total: the final amount paid, including tax and tip. Use a negative number for a refund or return.
- subtotal, tax, tip: as shown; 0 when not shown.
- currency: default ${s.currency} unless the receipt clearly shows another currency.
- category: ${categoryLine}
- payment_method: ${paymentLine} If one clearly matches, use its exact name. Otherwise describe what is shown (e.g. "Visa ending 4821"), or "" if unknown.
- notes: anything an accountant would want that doesn't fit elsewhere, such as an invoice number, the last four digits of a card, or who a meal was with when stated. Brief; "" if nothing.
- confidence and review_reasons: be honest. Add a short reason for anything you guessed or could not read clearly, or anything unusual (faded print, cut-off receipt, handwritten tip, totals that don't add up). Leave review_reasons empty when everything is clear.

If the input is not an expense at all, set is_expense to false, explain briefly in not_expense_reason, and return no records. Otherwise set is_expense to true and not_expense_reason to "".${extra}`;
}

function recordedLine(createdAt) {
  const d = new Date(createdAt);
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `Recorded on ${weekday}, ${toISODate(d)} at ${time}.`;
}

async function buildContent(entry, file) {
  const content = [];
  if (file) {
    const data = await blobToBase64(file);
    if (file.type === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: file.type || 'image/jpeg', data } });
    }
  }
  let text = recordedLine(entry.createdAt);
  if (entry.inputText) text += `\nThe user said: "${entry.inputText}"`;
  if (entry.userNote) text += `\nThe user's note about this receipt: "${entry.userNote}"`;
  if (file && !entry.inputText) text += '\nExtract the expense from this receipt.';
  content.push({ type: 'text', text });
  return content;
}

export async function extractExpenses(entry, file) {
  const s = settings();
  if (!s.ai.apiKey) throw new AIError('Add your AI key in Settings to read this entry.', 'auth');

  const params = {
    model: s.ai.model,
    max_tokens: 16000,
    system: buildSystemPrompt(s),
    messages: [{ role: 'user', content: await buildContent(entry, file) }],
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: buildSchema(s.categories) },
    },
  };

  let response;
  try {
    const api = client(s.ai.apiKey);
    if (FALLBACK_MODELS.has(params.model)) {
      response = await api.beta.messages.create({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } else {
      response = await api.messages.create(params);
    }
  } catch (err) {
    throw classify(err);
  }

  if (response.stop_reason === 'refusal') {
    throw new AIError('The AI declined to read this entry. You can fill it in by hand.', 'fatal');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new AIError('The AI response was cut off. Try again.', 'fatal');
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  let parsed;
  try {
    parsed = JSON.parse(textBlock?.text || '');
  } catch {
    throw new AIError('The AI returned something unexpected. Try again.', 'fatal');
  }
  return { ...parsed, model: response.model };
}

function classify(err) {
  if (err instanceof AIError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new AIError('Your AI key was rejected. Check it in Settings.', 'auth');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new AIError('Your AI key does not have permission to use this model. Check your Anthropic account.', 'auth');
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new AIError('That AI model is not available on your account. Pick another model in Settings.', 'fatal');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AIError('The AI is busy right now. It will try again shortly.', 'retry');
  }
  if (err instanceof Anthropic.BadRequestError) {
    const msg = err.error?.error?.message || err.message || '';
    if (/credit balance/i.test(msg)) {
      return new AIError('Your Anthropic account is out of credit. Add credit, then tap Try again.', 'auth');
    }
    return new AIError(`The AI could not read this entry: ${msg}`, 'fatal');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AIError('No connection. It will be read when you are back online.', 'offline');
  }
  if (err instanceof Anthropic.APIError) {
    // 5xx / 529 overloaded: temporary.
    return new AIError('The AI service had a hiccup. It will try again shortly.', 'retry');
  }
  return new AIError(err?.message || 'Something went wrong.', 'retry');
}
