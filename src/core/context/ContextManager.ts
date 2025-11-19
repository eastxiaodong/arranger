
import * as fs from 'fs/promises';
import * as path from 'path';
import { LLMMessage } from '../../infrastructure/llm';

// Describes a single modification to a message block.
// [timestamp, updateType, content, metadata]
type ContextUpdate = [number, string, string[], any[]];

// A map of all updates for a single message, keyed by the content block index.
type MessageUpdates = Map<number, ContextUpdate[]>;

// The in-memory representation of the entire history of changes.
// Map<messageIndex, [editType, MessageUpdates]>
type ContextHistoryUpdates = Map<number, [number, MessageUpdates]>;

// The format for serializing the history updates to disk.
type SerializedContextHistory = Array<
    [
        number, // messageIndex
        [
            number, // editType
            Array<[number, ContextUpdate[]]> // [blockIndex, updates]
        ]
    ]
>;

export class ContextManager {
    private contextHistoryUpdates: ContextHistoryUpdates;
    private promptTokenBudget: number;

    constructor(promptTokenBudget: number = 16000) {
        this.contextHistoryUpdates = new Map();
        this.promptTokenBudget = promptTokenBudget;
    }

    async loadHistory(taskDirectory: string): Promise<void> {
        const historyPath = path.join(taskDirectory, 'context-history.json');
        try {
            const data = await fs.readFile(historyPath, 'utf-8');
            const serializedHistory: SerializedContextHistory = JSON.parse(data);

            this.contextHistoryUpdates.clear();
            for (const [messageIndex, [editType, messageUpdatesArray]] of serializedHistory) {
                const messageUpdates: MessageUpdates = new Map(messageUpdatesArray);
                this.contextHistoryUpdates.set(messageIndex, [editType, messageUpdates]);
            }
        } catch (error) {
            const err = error as any;
            if (err?.code === 'ENOENT') {
                // History file doesn't exist, which is fine. Start with a clean slate.
                this.contextHistoryUpdates = new Map();
            } else {
                // For other errors, we should probably log them.
                console.error('Error loading context history:', err);
                throw err;
            }
        }
    }

    async saveHistory(taskDirectory: string): Promise<void> {
        const historyPath = path.join(taskDirectory, 'context-history.json');
        const serializedHistory: SerializedContextHistory = [];

        for (const [messageIndex, [editType, messageUpdates]] of this.contextHistoryUpdates.entries()) {
            const messageUpdatesArray = Array.from(messageUpdates.entries());
            serializedHistory.push([messageIndex, [editType, messageUpdatesArray]]);
        }

        await fs.writeFile(historyPath, JSON.stringify(serializedHistory, null, 2));
    }

    recordUpdate(messageIndex: number, blockIndex: number, updateType: string, content: string[], metadata: any[] = []) {
        if (!this.contextHistoryUpdates.has(messageIndex)) {
            this.contextHistoryUpdates.set(messageIndex, [1, new Map()]); // 1 for 'edit'
        }

        const [, messageUpdates] = this.contextHistoryUpdates.get(messageIndex)!;

        if (!messageUpdates.has(blockIndex)) {
            messageUpdates.set(blockIndex, []);
        }

        const timestamp = Date.now();
        messageUpdates.get(blockIndex)!.push([timestamp, updateType, content, metadata]);
    }

    async prepareContextForApiCall(fullHistory: LLMMessage[]): Promise<{ compactedHistory: LLMMessage[] }> {
        const compactedHistory = JSON.parse(JSON.stringify(fullHistory)); // Deep copy

        await this.optimizeContext(compactedHistory);

        const truncationRange = await this.truncateContext(compactedHistory, this.promptTokenBudget);

        if (truncationRange) {
            compactedHistory.splice(truncationRange.start, truncationRange.count);

            // Add truncation notice
            if (compactedHistory.length > 1 && compactedHistory[1].role === 'assistant') {
                const notice = "[NOTE] Some previous conversation history has been removed to save space.]";
                if (!compactedHistory[1].content.includes(notice)) {
                    compactedHistory[1].content = notice + '\n' + compactedHistory[1].content;
                    this.recordUpdate(1, 0, 'prepend', [notice]);
                }
            }
        }

        return { compactedHistory };
    }

    private estimateTokens(content?: string | null): number {
        if (!content) {
            return 0;
        }
        // A simple approximation
        return Math.ceil(content.length / 4);
    }

    private async truncateContext(history: LLMMessage[], maxTokens: number): Promise<{ start: number; count: number } | null> {
        let currentTokens = history.reduce((sum, msg) => sum + this.estimateTokens(msg.content), 0);

        if (currentTokens <= maxTokens) {
            return null; // No truncation needed
        }

        // Always preserve the first user/assistant pair (if they exist)
        const preserveUpTo = (history.length > 1 && history[0].role === 'user' && history[1].role === 'assistant') ? 2 : 0;

        // Don't truncate the last message (the current prompt)
        const keepAtEnd = 1;

        let removableCount = history.length - preserveUpTo - keepAtEnd;
        if (removableCount <= 0) {
            return null;
        }

        let removeStartIndex = preserveUpTo;
        let countToRemove = 0;

        while (currentTokens > maxTokens && removableCount > 0) {
            const messageToRemove = history[removeStartIndex + countToRemove];
            currentTokens -= this.estimateTokens(messageToRemove.content);
            countToRemove++;
            removableCount--;
        }

        // Ensure we remove an even number of messages to keep turns balanced
        if (countToRemove % 2 !== 0 && removableCount > 0) {
            const messageToRemove = history[removeStartIndex + countToRemove];
            currentTokens -= this.estimateTokens(messageToRemove.content);
            countToRemove++;
        }

        if (countToRemove > 0) {
            return { start: removeStartIndex, count: countToRemove };
        }

        return null;
    }

    private async optimizeContext(history: LLMMessage[]): Promise<boolean> {
        const readFiles = new Set<string>();
        let optimized = false;

        for (let i = 0; i < history.length; i++) {
            const message = history[i];

            // Check for tool call results for read_file
            if (message.role === 'user' && message.content.startsWith('Tool read_file')) {
                const match = message.content.match(/Tool read_file \(input: (.*)\) result:/);
                if (match && match[1]) {
                    try {
                        const input = JSON.parse(match[1]);
                        if (input && typeof input.path === 'string') {
                            const filePath = input.path;
                            if (readFiles.has(filePath)) {
                                const placeholder = `[DUPLICATE FILE READ: ${filePath}]`;
                                history[i].content = placeholder;
                                this.recordUpdate(i, 0, 'replace', [placeholder]);
                                optimized = true;
                            } else {
                                readFiles.add(filePath);
                            }
                        }
                    } catch (e) {
                        // Ignore if JSON parsing fails
                    }
                }
            }

            // Check for <file_content> tags
            const fileContentRegex = /<file_content path="([^"]+)">[\s\S]*?<\/file_content>/g;
            let contentMatch;
            let newContent = message.content;
            let fileReplaced = false;
            while ((contentMatch = fileContentRegex.exec(message.content)) !== null) {
                const filePath = contentMatch[1];
                if (readFiles.has(filePath)) {
                    const placeholder = `[DUPLICATE FILE READ: ${filePath}]`;
                    newContent = newContent.replace(contentMatch[0], placeholder);
                    fileReplaced = true;
                    optimized = true;
                } else {
                    readFiles.add(filePath);
                }
            }

            if (fileReplaced) {
                history[i].content = newContent;
                this.recordUpdate(i, 0, 'replace', [newContent]);
            }
        }
        return optimized;
    }
}
