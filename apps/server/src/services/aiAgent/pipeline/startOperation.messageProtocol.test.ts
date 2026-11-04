import { describe, expect, it, vi } from 'vitest';

import { startOperation } from './startOperation';

vi.mock('@/libs/trpc/utils/internalJwt', () => ({
  signUserJWT: vi.fn().mockResolvedValue('jwt'),
}));

const sourceExecutor = { capabilities: ['llm_relay@1'], clientId: 'tab-a', providers: ['ollama'] };

const setup = (sourceAccepts: boolean) => {
  const calls: string[] = [];
  const agentRuntimeService = {
    acceptsFileWorks: vi.fn(async () => sourceAccepts),
    acceptsMemberRuntimeEnd: vi.fn(async () => {
      calls.push('read-source');
      return sourceAccepts;
    }),
    createOperation: vi.fn(async () => ({ autoStarted: true, messageId: 'msg-assistant' })),
    getLlmExecutor: vi.fn(async () => {
      calls.push('read-executor');
      return sourceExecutor;
    }),
    getOperationClientProtocol: vi.fn().mockResolvedValue(2),
    getOperationEditingGroupId: vi.fn(async () => undefined),
  };
  const deps = {
    agentRuntimeService,
    messageModel: {},
    retirePendingApprovalOperation: vi.fn(async () => {
      calls.push('retire-source');
    }),
    topicModel: { updateMetadata: vi.fn() },
    userId: 'user-1',
    withholdGatewayToken: true,
  } as any;
  const ctx = {
    agentConfig: {},
    assistantMessageId: 'msg-assistant',
    model: 'gpt',
    provider: 'openai',
    resolvedAgentId: 'agt-supervisor',
    topicId: 'tpc-1',
    userMessageId: 'msg-user',
  } as any;
  const input = (extra: Record<string, unknown>) =>
    ({
      approvalClaim: {},
      approvalSourceToolMessageIds: [],
      autoStart: true,
      discovery: {
        credentialFactsPromise: Promise.resolve(undefined),
        modelMediaCapabilities: {},
        toolsResult: { enabledToolIds: [] },
      },
      initialContext: {},
      operationId: 'op-new',
      prep: { allMessages: [], deviceSystemInfo: {} },
      updateAbortedAssistantMessage: vi.fn(),
      userInterventionConfig: { approvalMode: 'manual' },
      ...extra,
    }) as any;
  return { agentRuntimeService, calls, ctx, deps, input };
};

describe('startOperation message protocol inheritance', () => {
  it.each(['parentOperationId', 'approvalSourceOperationId', 'messageProtocolSourceOperationId'])(
    'inherits protocol 2 through %s',
    async (source) => {
      const { agentRuntimeService, ctx, deps, input } = setup(true);
      await startOperation(deps, ctx, input({ [source]: 'op-parent' }));
      expect(agentRuntimeService.createOperation).toHaveBeenCalledWith(
        expect.objectContaining({ clientProtocol: 2 }),
      );
    },
  );

  it('keeps an explicit legacy declaration over a v2 parent', async () => {
    const { agentRuntimeService, ctx, deps, input } = setup(true);
    await startOperation(deps, ctx, input({ clientProtocol: 1, parentOperationId: 'parent' }));
    expect(agentRuntimeService.createOperation).toHaveBeenCalledWith(
      expect.objectContaining({ clientProtocol: 1 }),
    );
    expect(agentRuntimeService.getOperationClientProtocol).not.toHaveBeenCalled();
  });

  it('keeps independent CLI runs on the default protocol', async () => {
    const { agentRuntimeService, ctx, deps, input } = setup(true);
    await startOperation(deps, ctx, input({}));
    expect(agentRuntimeService.createOperation).toHaveBeenCalledWith(
      expect.objectContaining({ clientProtocol: undefined }),
    );
    expect(agentRuntimeService.getOperationClientProtocol).not.toHaveBeenCalled();
  });

  it('continues safely when the source declaration cannot be read', async () => {
    const { agentRuntimeService, ctx, deps, input } = setup(true);
    agentRuntimeService.getOperationClientProtocol.mockRejectedValue(new Error('unavailable'));
    await startOperation(deps, ctx, input({ parentOperationId: 'parent' }));
    expect(agentRuntimeService.createOperation).toHaveBeenCalled();
  });
});
