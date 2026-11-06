type VercelRequestLike = {
  method?: string;
  body?: unknown;
};

type VercelResponseLike = {
  status(code: number): VercelResponseLike;
  json(body: unknown): void;
};

type GeneratedQuest = {
  title: string;
  xp: number;
  zone: 'desk' | 'door' | 'wall';
};

const REQUEST_TIMEOUT_MS = 8_000;
const ZONES = new Set<GeneratedQuest['zone']>(['desk', 'door', 'wall']);

function readApiKey(): string | undefined {
  // Read Vercel's process.env.OPENAI_API_KEY only here; this module is server-only.
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.OPENAI_API_KEY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateQuests(value: unknown): GeneratedQuest[] | null {
  if (!isRecord(value) || !Array.isArray(value.quests)) return null;
  if (value.quests.length < 3 || value.quests.length > 5) return null;

  const quests: GeneratedQuest[] = [];
  for (const item of value.quests) {
    if (!isRecord(item)) return null;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const xp = item.xp;
    const zone = item.zone;
    if (
      title.length === 0 ||
      title.split(/\s+/u).length > 6 ||
      !Number.isInteger(xp) ||
      (xp as number) < 10 ||
      (xp as number) > 50 ||
      typeof zone !== 'string' ||
      !ZONES.has(zone as GeneratedQuest['zone'])
    ) {
      return null;
    }
    quests.push({ title, xp: xp as number, zone: zone as GeneratedQuest['zone'] });
  }
  return quests;
}

export default async function handler(
  request: VercelRequestLike,
  response: VercelResponseLike,
): Promise<void> {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  const body = request.body;
  const text = isRecord(body) && typeof body.text === 'string' ? body.text : '';
  const length = Array.from(text).length;
  if (text.trim().length === 0) {
    response.status(400).json({ error: 'text-required' });
    return;
  }
  if (length > 1_000) {
    response.status(413).json({ error: 'text-too-long' });
    return;
  }

  const apiKey = readApiKey();
  if (!apiKey) {
    response.status(500).json({ error: 'server-not-configured' });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const openAIResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'Turn the spoken task list into 3 to 5 concise, actionable quest cards. Titles must use at most six words. Assign each quest to desk, door, or wall. Award 10 to 50 XP based on effort.',
          },
          { role: 'user', content: text },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'quest_suggestions',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                quests: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      title: { type: 'string' },
                      xp: { type: 'integer', minimum: 10, maximum: 50 },
                      zone: { type: 'string', enum: ['desk', 'door', 'wall'] },
                    },
                    required: ['title', 'xp', 'zone'],
                  },
                },
              },
              required: ['quests'],
            },
          },
        },
      }),
    });

    if (!openAIResponse.ok) {
      response.status(502).json({ error: 'quest-generation-failed' });
      return;
    }

    const completion = (await openAIResponse.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = completion.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      response.status(502).json({ error: 'invalid-model-response' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      response.status(502).json({ error: 'invalid-model-response' });
      return;
    }
    const quests = validateQuests(parsed);
    if (quests === null) {
      response.status(502).json({ error: 'invalid-model-response' });
      return;
    }
    response.status(200).json({ quests });
  } catch {
    response
      .status(controller.signal.aborted ? 504 : 502)
      .json({ error: controller.signal.aborted ? 'timeout' : 'quest-generation-failed' });
  } finally {
    clearTimeout(timeout);
  }
}
