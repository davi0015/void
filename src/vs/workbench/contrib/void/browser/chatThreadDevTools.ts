/*--------------------------------------------------------------------------------------
 *  Dev-only helpers for testing chat performance. Not shipped in production builds.
 *  Call from the Void dev console (Help → Toggle Developer Tools).
 *
 *  Usage:
 *    __voidChatThreadService._populateTestThread(50)
 *    __voidChatThreadService._simulateStream({ repetitions: 5 })
 *    __voidChatStats()
 *--------------------------------------------------------------------------------------*/

import { IChatThreadService, ThreadStreamState } from './chatThreadService.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';

export type StreamCallbacks = {
	addMessage: (threadId: string, msg: ChatMessage) => void
	setStreamState: (threadId: string, state: ThreadStreamState[string]) => void
	scheduleStreamTextUpdate: (threadId: string, state: ThreadStreamState[string]) => void
}

export function registerChatDevTools(chatThreadService: IChatThreadService) {
	;(globalThis as any).__voidChatThreadService = chatThreadService
	;(globalThis as any).__voidChatStats = () => chatStats(chatThreadService)
}

export function chatStats(svc: IChatThreadService) {
	const thread = svc.getCurrentThread()
	const msgs = thread.messages
	let totalDisplayChars = 0, totalReasoningChars = 0, totalUserChars = 0, totalToolChars = 0
	let assistantCount = 0, userCount = 0, toolCount = 0
	for (const m of msgs) {
		if (m.role === 'assistant') {
			totalDisplayChars += (m.displayContent || '').length
			totalReasoningChars += (m.reasoning || '').length
			assistantCount++
		} else if (m.role === 'user') {
			totalUserChars += (m.displayContent || '').length
			userCount++
		} else if (m.role === 'tool') {
			totalToolChars += JSON.stringify(m).length
			toolCount++
		}
	}
	const totalChars = totalDisplayChars + totalReasoningChars + totalUserChars + totalToolChars
	const estTokens = Math.round(totalChars / 4)
	console.table({
		'Messages': { count: msgs.length, chars: totalChars, '~tokens': estTokens },
		'User': { count: userCount, chars: totalUserChars, '~tokens': Math.round(totalUserChars / 4) },
		'Assistant (display)': { count: assistantCount, chars: totalDisplayChars, '~tokens': Math.round(totalDisplayChars / 4) },
		'Assistant (reasoning)': { count: assistantCount, chars: totalReasoningChars, '~tokens': Math.round(totalReasoningChars / 4) },
		'Tool': { count: toolCount, chars: totalToolChars, '~tokens': Math.round(totalToolChars / 4) },
	})
	return { totalChars, estTokens, totalDisplayChars, totalReasoningChars, totalUserChars, totalToolChars, messageCount: msgs.length }
}


// ── Static data population ──────────────────────────────────────────────

const loremParagraphs = [
	'The architecture of modern distributed systems requires careful consideration of fault tolerance, consistency guarantees, and performance characteristics. When designing a system that needs to handle millions of requests per second, we must think about how data flows through the pipeline, where bottlenecks might occur, and how to gracefully degrade under load.',
	'Consider a microservices architecture where each service maintains its own database. The challenge of maintaining data consistency across service boundaries is non-trivial. We can use the Saga pattern, where each service publishes events that trigger compensating transactions in other services if a step fails. Alternatively, we can use two-phase commit protocols, though these come with significant performance costs.',
	'Event sourcing provides an interesting alternative to traditional CRUD operations. Instead of storing the current state, we store the sequence of events that led to the current state. This gives us a complete audit trail, the ability to replay events to rebuild state, and the flexibility to project events into different read models optimized for specific query patterns.',
	'The CAP theorem tells us that in the presence of network partitions, we must choose between consistency and availability. In practice, most systems need to be available, so we opt for eventual consistency. This means our read models may be slightly stale, but the system continues to operate even when some nodes are unreachable.',
	'Caching strategies play a crucial role in system performance. A multi-layer cache (L1 in-process, L2 distributed like Redis, L3 CDN) can reduce database load by orders of magnitude. Cache invalidation remains one of the hardest problems — we can use TTL-based expiry, event-driven invalidation, or a combination of both.',
]

const codeBlocks = [
	'```typescript\ninterface EventStore<T extends BaseEvent> {\n  append(streamId: string, events: T[], expectedVersion: number): Promise<void>;\n  read(streamId: string, fromVersion?: number): AsyncIterable<T>;\n  subscribe(pattern: string, handler: (event: T) => Promise<void>): Disposable;\n}\n\nclass PostgresEventStore implements EventStore<DomainEvent> {\n  private readonly pool: Pool;\n  private readonly serializer: EventSerializer;\n\n  async append(streamId: string, events: DomainEvent[], expectedVersion: number): Promise<void> {\n    const client = await this.pool.connect();\n    try {\n      await client.query(\'BEGIN\');\n      const current = await this.getCurrentVersion(client, streamId);\n      if (current !== expectedVersion) {\n        throw new OptimisticConcurrencyError(streamId, expectedVersion, current);\n      }\n      for (const event of events) {\n        await client.query(\n          \'INSERT INTO events (stream_id, version, type, data, metadata) VALUES ($1, $2, $3, $4, $5)\',\n          [streamId, ++expectedVersion, event.type, this.serializer.serialize(event), event.metadata]\n        );\n      }\n      await client.query(\'COMMIT\');\n    } catch (e) {\n      await client.query(\'ROLLBACK\');\n      throw e;\n    } finally {\n      client.release();\n    }\n  }\n}\n```',
	'```python\nfrom dataclasses import dataclass\nfrom typing import Protocol, AsyncIterator\nimport asyncio\n\n@dataclass(frozen=True)\nclass CacheEntry:\n    value: bytes\n    ttl_ms: int\n    created_at: float\n    version: int\n\nclass CacheLayer(Protocol):\n    async def get(self, key: str) -> CacheEntry | None: ...\n    async def set(self, key: str, entry: CacheEntry) -> None: ...\n    async def invalidate(self, key: str) -> None: ...\n\nclass MultiLayerCache:\n    def __init__(self, layers: list[CacheLayer]):\n        self._layers = layers\n\n    async def get(self, key: str) -> bytes | None:\n        for i, layer in enumerate(self._layers):\n            entry = await layer.get(key)\n            if entry is not None:\n                # backfill upper layers\n                for upper in self._layers[:i]:\n                    await upper.set(key, entry)\n                return entry.value\n        return None\n\n    async def invalidate(self, key: str) -> None:\n        await asyncio.gather(*[l.invalidate(key) for l in self._layers])\n```',
	'```rust\nuse tokio::sync::{RwLock, broadcast};\nuse std::collections::HashMap;\nuse std::sync::Arc;\n\npub struct ConsistentHashRing<T: Clone> {\n    ring: BTreeMap<u64, T>,\n    replicas: usize,\n}\n\nimpl<T: Clone + Hash> ConsistentHashRing<T> {\n    pub fn new(replicas: usize) -> Self {\n        Self { ring: BTreeMap::new(), replicas }\n    }\n\n    pub fn add_node(&mut self, node: T) {\n        for i in 0..self.replicas {\n            let hash = self.hash(&format!("{:?}-{}", node, i));\n            self.ring.insert(hash, node.clone());\n        }\n    }\n\n    pub fn get_node(&self, key: &str) -> Option<&T> {\n        if self.ring.is_empty() { return None; }\n        let hash = self.hash(key);\n        self.ring.range(hash..).next()\n            .or_else(|| self.ring.iter().next())\n            .map(|(_, v)| v)\n    }\n\n    fn hash(&self, key: &str) -> u64 {\n        let mut hasher = DefaultHasher::new();\n        key.hash(&mut hasher);\n        hasher.finish()\n    }\n}\n```',
]

const reasoningBlocks = [
	'Let me analyze this step by step. The user is asking about distributed system design patterns. I need to consider several aspects:\n\n1. First, what are the consistency requirements? Strong consistency vs eventual consistency has major implications for the architecture.\n\n2. The throughput requirements suggest we need horizontal scaling, which means we should consider sharding strategies.\n\n3. Looking at the existing codebase, I can see they\'re using PostgreSQL as the primary store. We should leverage its LISTEN/NOTIFY for change data capture rather than introducing a separate message broker.\n\n4. The latency requirements (p99 < 50ms) mean we need aggressive caching. The current architecture doesn\'t have a cache layer, which explains the performance issues they\'re seeing.\n\n5. I should also consider the operational complexity. Adding Redis as a cache layer is well-understood, but it introduces another failure mode. We need circuit breakers and fallback paths.\n\n6. The data model suggests a natural partition key on tenant_id. This would give us good distribution across shards while keeping related data co-located for efficient queries.\n\n7. For the write path, we can use a command queue to decouple the API layer from the processing layer. This gives us natural backpressure handling and retry capability.\n\n8. The read path can be optimized with materialized views that are updated asynchronously from the event log. This is essentially CQRS without the full event sourcing complexity.',
	'I need to think through the implications of this refactoring carefully.\n\nThe current code has a tight coupling between the HTTP handler and the database layer. Every request goes through:\n1. Parse request → validate → transform → query DB → transform response → serialize\n\nThe problem is that steps 3 and 5 contain business logic that\'s duplicated across 12 different endpoints. When we changed the pricing calculation last month, we had to update it in 8 places.\n\nThe solution is to extract a domain service layer:\n- HTTP handlers only deal with request/response serialization\n- Domain services contain business logic and validation\n- Repository interfaces abstract the database\n\nBut I need to be careful about:\n- Not over-abstracting. We don\'t need a full DDD implementation for a service this size.\n- Keeping the migration incremental. We can\'t rewrite everything at once.\n- Making sure the new structure doesn\'t introduce performance regressions. The current direct-query approach is fast; adding layers could slow things down if we\'re not careful about N+1 queries.\n\nI\'ll start with the pricing calculation since that\'s the most duplicated piece. Extract it into a PricingService, write tests for it in isolation, then gradually replace the inline calculations in each endpoint.',
	'This is a complex debugging scenario. Let me trace through the execution path:\n\nThe error occurs when `processCheckpoint` is called with a thread that has already been partially committed. The stack trace shows:\n\n1. `_addUserMessageAndStreamResponse` initiates the stream\n2. The LLM responds with a tool call\n3. `_runToolCall` executes the tool\n4. The tool modifies a file\n5. `_addCheckpoint` captures the state\n6. A second tool call comes in before the first checkpoint is fully persisted\n7. The concurrent write to `_storeAllThreads` causes the state to be partially overwritten\n\nThe root cause is that `_storeAllThreads` serializes the entire thread map on every call, and two concurrent calls can race. The second call reads stale state (missing the first checkpoint) and overwrites it.\n\nThe fix should be:\n- Use a write queue that serializes storage operations\n- Or use optimistic concurrency with a version counter on the thread\n- Or batch the checkpoint + message additions into a single atomic state update\n\nThe simplest fix is the batching approach since we already have `_setState` which is synchronous. We just need to make sure `_addCheckpoint` and `_addMessageToThread` are called in the same synchronous block before any await.',
]

const userMessages = [
	'Can you explain how event sourcing works in the context of a distributed microservices architecture? I\'m particularly interested in how to handle the consistency challenges.',
	'That makes sense. How would you implement the event store in practice? What database would you use and how would you handle schema evolution?',
	'I see. Now can you show me how to implement a multi-layer cache with proper invalidation? I want to make sure we handle cache stampede correctly.',
	'Great explanation. What about the consistent hashing for distributing cache keys across multiple Redis nodes? Can you show a Rust implementation?',
	'How do we handle the case where a node goes down and we need to rebalance? I want to understand the replication strategy.',
	'Can you walk me through a complete example of CQRS with event sourcing? I want to see how commands flow through the system and how read models are projected.',
	'What are the testing strategies for event-sourced systems? How do you test the projections and ensure they stay in sync?',
	'Let\'s talk about monitoring and observability. What metrics should we track for an event-sourced system? How do we detect when projections fall behind?',
	'How does this all work with Kubernetes? What are the deployment patterns for event-sourced microservices?',
	'Can you explain how to handle versioning and backward compatibility when the event schema changes? What migration strategies work best?',
	'What about performance optimization? How do we handle hot partitions and ensure even distribution of load across the cluster?',
	'Let me understand the failure modes better. What happens when the event store becomes unavailable? How do we design for graceful degradation?',
	'Can you show me how to implement a circuit breaker pattern that works with our event-sourced architecture?',
	'How do we handle cross-service transactions in this architecture? What are the alternatives to distributed transactions?',
	'Finally, can you summarize the key architectural decisions and tradeoffs we\'ve discussed? I want to document this for the team.',
]

export function buildTestMessages(turns: number): ChatMessage[] {
	const messages: ChatMessage[] = []

	for (let turn = 0; turn < turns; turn++) {
		const userMsg = userMessages[turn % userMessages.length]
		messages.push({
			role: 'user',
			content: `[Turn ${turn + 1}] ${userMsg}`,
			displayContent: `[Turn ${turn + 1}] ${userMsg}`,
			selections: null,
			state: { stagingSelections: [], isBeingEdited: false },
		})

		const reasoning = reasoningBlocks[turn % reasoningBlocks.length]
		const paragraphs = []
		for (let p = 0; p < 3; p++) {
			paragraphs.push(loremParagraphs[(turn * 3 + p) % loremParagraphs.length])
		}
		const code = codeBlocks[turn % codeBlocks.length]
		const displayContent = paragraphs[0] + '\n\n' + paragraphs[1] + '\n\n' + code + '\n\n' + paragraphs[2]

		messages.push({
			role: 'assistant',
			displayContent,
			reasoning,
			anthropicReasoning: null,
		})
	}

	return messages
}


// ── Streaming simulation content ────────────────────────────────────────

const streamReasoningText = [
	'Let me analyze this step by step.\n\n',
	'First, I need to understand the architecture of the system. The user is asking about performance optimization ',
	'for a React-based chat interface that renders markdown content. The key challenge is that the rendering pipeline ',
	'involves multiple expensive operations:\n\n',
	'1. **Markdown lexing** — `marked.lexer()` parses the full string into tokens on every update\n',
	'2. **React reconciliation** — every token produces a React element that must be diffed\n',
	'3. **Monaco editor mounting** — code blocks trigger full CodeEditorWidget construction\n\n',
	'The core insight is that streaming is append-only. If I can preserve the already-rendered prefix and only process ',
	'the new tail, the per-frame cost becomes O(delta) instead of O(total). This requires:\n\n',
	'- An incremental lexer that reuses token objects for unchanged blocks\n',
	'- `React.memo` on `RenderToken` so stable references skip reconciliation\n',
	'- Deferred Monaco mounting via `LazyBlockCode` (already implemented)\n\n',
	'Let me also consider the interaction with the existing `cachedLex` — it caches by full string, so it\'s useless ',
	'during streaming where the string changes every frame. The incremental approach replaces it for the streaming path.\n\n',
	'I should be careful about markdown constructs that span multiple blocks — an unclosed code fence means the last ',
	'token is still growing and can\'t be frozen. The safe boundary is "all tokens except the last one" which handles ',
	'this naturally since the incomplete fence stays as the tail token until it closes.\n\n',
	'Another consideration: the `isStreaming` prop flows through to `LazyBlockCode` and prevents Monaco mounting ',
	'during streaming. This is correct and should be preserved — we only want the incremental optimization on the ',
	'lexer and React reconciliation layers, not on the Monaco mounting layer.',
].join('')

const streamDisplayText = [
	'## Performance Analysis\n\n',
	'The rendering pipeline has three main bottlenecks when dealing with large conversations:\n\n',
	'### 1. Markdown Lexing\n\n',
	'The `marked.lexer()` function parses the entire message string into structured tokens on every frame. ',
	'For a 100k-character message at 20Hz streaming updates, that\'s **2 million characters per second** of parsing work. ',
	'The existing `cachedLex` cache doesn\'t help during streaming because the content string changes on every chunk.\n\n',
	'### 2. React Reconciliation\n\n',
	'Even though React uses `key={index}` for stable DOM identity, `RenderToken` is not wrapped in `React.memo`. ',
	'This means React re-executes every component function on every frame, walking the entire token tree to discover ',
	'that only the last 1-2 tokens actually changed.\n\n',
	'### 3. Code Block Rendering\n\n',
	'Each fenced code block renders a `LazyBlockCode` component. During streaming, these stay as plain `<pre>` ',
	'elements (correct optimization already in place). But once committed, the IntersectionObserver triggers ',
	'Monaco editor mounting for all visible code blocks.\n\n',
	'```typescript\n',
	'class IncrementalLexer {\n',
	'  private prevString = \'\';\n',
	'  private tokens: Token[] = [];\n',
	'\n',
	'  lex(newString: string): Token[] {\n',
	'    if (newString === this.prevString) return this.tokens;\n',
	'\n',
	'    if (newString.startsWith(this.prevString) && this.tokens.length > 0) {\n',
	'      const stable = this.tokens.slice(0, -1);\n',
	'      const stableOffset = stable.reduce((s, t) => s + t.raw.length, 0);\n',
	'      const tail = marked.lexer(newString.slice(stableOffset));\n',
	'      this.tokens = [...stable, ...tail];\n',
	'    } else {\n',
	'      this.tokens = marked.lexer(newString);\n',
	'    }\n',
	'\n',
	'    this.prevString = newString;\n',
	'    return this.tokens;\n',
	'  }\n',
	'}\n',
	'```\n\n',
	'### Recommended Fix\n\n',
	'The combination of **incremental lexing** and **`React.memo` on `RenderToken`** would reduce the per-frame ',
	'cost from O(total_tokens) to O(tail_tokens) — typically 1-3 tokens regardless of conversation length. ',
	'Both the CPU work (lexing) and the React work (reconciliation) become constant per frame.\n\n',
	'The incremental lexer preserves object references for stable tokens, and `React.memo`\'s default shallow ',
	'comparison catches those stable references and skips re-rendering entirely. Only the growing tail token ',
	'and any newly completed tokens get fresh objects that pass through the memo gate.\n\n',
	'| Metric | Before | After |\n',
	'|--------|--------|-------|\n',
	'| Lexer work per frame | O(n) full string | O(delta) tail only |\n',
	'| React components re-rendered | All tokens | 1-3 tail tokens |\n',
	'| Main thread budget consumed | 15-30ms | <1ms |\n',
].join('')

function repeatBlock(text: string, n: number): string {
	if (n <= 1) return text
	const parts = [text]
	for (let i = 2; i <= n; i++) {
		parts.push(`\n\n---\n\n### Continuation (part ${i}/${n})\n\n` + text)
	}
	return parts.join('')
}

export function getStreamContent(opts?: { includeReasoning?: boolean, repetitions?: number }) {
	const includeReasoning = opts?.includeReasoning ?? true
	const repetitions = opts?.repetitions ?? 1
	const reasoning = includeReasoning ? repeatBlock(streamReasoningText, repetitions) : ''
	const display = repeatBlock(streamDisplayText, repetitions)
	return { reasoning, display }
}

export function runSimulatedStream(
	threadId: string,
	cb: StreamCallbacks,
	opts?: { charsPerChunk?: number, intervalMs?: number, includeReasoning?: boolean, repetitions?: number },
): void {
	const charsPerChunk = opts?.charsPerChunk ?? 30
	const intervalMs = opts?.intervalMs ?? 40
	const { reasoning: fullReasoning, display: fullDisplay } = getStreamContent(opts)

	const userMsg = 'Can you analyze the performance bottlenecks in the chat rendering pipeline and suggest fixes for handling large conversations with 90k+ tokens?'
	cb.addMessage(threadId, {
		role: 'user', content: userMsg, displayContent: userMsg,
		selections: null, state: { stagingSelections: [], isBeingEdited: false },
	})

	cb.setStreamState(threadId, {
		isRunning: 'LLM',
		llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallsSoFar: [] },
		interrupt: Promise.resolve(() => { clearInterval(timer) }),
	})

	let rIdx = 0, dIdx = 0
	let phase: 'reasoning' | 'display' = fullReasoning ? 'reasoning' : 'display'

	const timer = setInterval(() => {
		if (phase === 'reasoning') {
			rIdx = Math.min(rIdx + charsPerChunk, fullReasoning.length)
			cb.scheduleStreamTextUpdate(threadId, {
				isRunning: 'LLM',
				llmInfo: { displayContentSoFar: '', reasoningSoFar: fullReasoning.slice(0, rIdx), toolCallsSoFar: [] },
				interrupt: Promise.resolve(() => { clearInterval(timer) }),
			})
			if (rIdx >= fullReasoning.length) phase = 'display'
		} else {
			dIdx = Math.min(dIdx + charsPerChunk, fullDisplay.length)
			cb.scheduleStreamTextUpdate(threadId, {
				isRunning: 'LLM',
				llmInfo: { displayContentSoFar: fullDisplay.slice(0, dIdx), reasoningSoFar: fullReasoning, toolCallsSoFar: [] },
				interrupt: Promise.resolve(() => { clearInterval(timer) }),
			})
			if (dIdx >= fullDisplay.length) {
				clearInterval(timer)
				cb.addMessage(threadId, { role: 'assistant', displayContent: fullDisplay, reasoning: fullReasoning, anthropicReasoning: null })
				cb.setStreamState(threadId, { isRunning: undefined })
				const total = fullReasoning.length + fullDisplay.length
				console.log(`[test] Simulated stream complete. Total: ${total} chars (~${Math.round(total / 4)} tokens)`)
			}
		}
	}, intervalMs)

	const total = fullReasoning.length + fullDisplay.length
	console.log(`[test] Streaming started (${charsPerChunk} chars every ${intervalMs}ms, est ~${Math.round(total / 4)} tokens)`)
}
