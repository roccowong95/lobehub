import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OperationInitRequest } from './operationInit';
import type { StartOperationDeps, StartOperationInput } from './startOperation';
import { startOperation } from './startOperation';

vi.mock('@/libs/trpc/utils/internalJwt', () => ({
  signUserJWT: vi.fn().mockResolvedValue('jwt'),
}));

const pendingRequest = {
  approvedToolEntries: [],
  globalMemoryEnabled: false,
  hasMentionedAgents: false,
  isFixedDeviceTarget: false,
  prompt: 'Continue the operation',
  resumeFromHistory: false,
  runAttachments: { warnings: [] },
} satisfies OperationInitRequest;

afterEach(() => vi.restoreAllMocks());

const sourceExecutor = { capabilities: ['llm_relay@1'], clientId: 'tab-a', providers: ['ollama'] };

const setup = (sourceAccepts: boolean) => {
  const calls: string[] = [];
  const agentRuntimeService = {
    acceptsFileWorks: vi.fn(async () => sourceAccepts),
    acceptsMemberRuntimeEnd: vi.fn(async () => {
      calls.push('read-source');
      return sourceAccepts;
    }),
    createOperation: vi.fn(
      async (
        _params: Parameters<StartOperationDeps['agentRuntimeService']['createOperation']>[0],
      ) => ({ autoStarted: true, messageId: 'msg-assistant' }),
    ),
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
  const input = (extra: Partial<StartOperationInput>) =>
    ({
      approvalClaim: {},
      approvalSourceToolMessageIds: [],
      autoStart: true,
      init: {
        discovery: {
          credentialFactsPromise: Promise.resolve(undefined),
          modelMediaCapabilities: {},
          toolsResult: { enabledToolIds: [] },
        },
        initialContext: {},
        prep: { allMessages: [], deviceSystemInfo: {} },
      },
      operationId: 'op-new',
      updateAbortedAssistantMessage: vi.fn(),
      userInterventionConfig: { approvalMode: 'manual' },
      ...extra,
    }) as any;
  return { agentRuntimeService, calls, ctx, deps, input };
};

describe.each(['resolved', 'pending'] as const)(
  'startOperation %s init message protocol inheritance',
  (mode) => {
    const setupInit = () => {
      const fixture = setup(true);
      return {
        ...fixture,
        input: (extra: Partial<StartOperationInput>) =>
          fixture.input({
            ...(mode === 'pending' ? { init: { pendingRequest } } : {}),
            ...extra,
          }),
      };
    };
    it.each(['parentOperationId', 'approvalSourceOperationId', 'messageProtocolSourceOperationId'])(
      'inherits protocol 2 through %s',
      async (source) => {
        const { agentRuntimeService, ctx, deps, input } = setupInit();
        await startOperation(deps, ctx, input({ [source]: 'op-parent' }));
        expect(agentRuntimeService.getOperationClientProtocol).toHaveBeenCalledWith('op-parent');
        expect(agentRuntimeService.createOperation).toHaveBeenCalledWith(
          expect.objectContaining({ clientProtocol: 2 }),
        );
      },
    );

    it.each([1, 2] as const)(
      'keeps explicit protocol %s over a source declaration',
      async (clientProtocol) => {
        const { agentRuntimeService, ctx, deps, input } = setupInit();
        await startOperation(deps, ctx, input({ clientProtocol, parentOperationId: 'parent' }));
        expect(agentRuntimeService.createOperation).toHaveBeenCalledWith(
          expect.objectContaining({ clientProtocol }),
        );
        expect(agentRuntimeService.getOperationClientProtocol).not.toHaveBeenCalled();
      },
    );

    it.each([
      {
        approvalSourceOperationId: 'approval',
        parentOperationId: 'parent',
        messageProtocolSourceOperationId: 'callback',
        expected: 'approval',
      },
      {
        parentOperationId: 'parent',
        messageProtocolSourceOperationId: 'callback',
        expected: 'parent',
      },
    ])('selects the highest-priority source $expected', async ({ expected, ...sources }) => {
      const { agentRuntimeService, ctx, deps, input } = setupInit();
      agentRuntimeService.getOperationClientProtocol.mockImplementation(async (source) =>
        source === expected ? 1 : 2,
      );
      await startOperation(deps, ctx, input(sources));
      expect(agentRuntimeService.getOperationClientProtocol).toHaveBeenCalledExactlyOnceWith(
        expected,
      );
      expect(agentRuntimeService.createOperation).toHaveBeenCalledWith(
        expect.objectContaining({ clientProtocol: 1 }),
      );
    });

    it('preserves the selected initialization path', async () => {
      const { agentRuntimeService, ctx, deps, input } = setupInit();
      const request = input({ parentOperationId: 'parent' });
      const result = await startOperation(deps, ctx, request);
      expect(result.success).toBe(true);
      const created = agentRuntimeService.createOperation.mock.calls[0][0];
      if (mode === 'pending') {
        expect(created.pendingInitRequest).toBe(request.init.pendingRequest);
        expect(created.initialContext.phase).toBe('user_input');
        expect(created.initialContext.session.sessionId).toBe('op-new');
      } else {
        expect(created.pendingInitRequest).toBeUndefined();
        expect(created.initialContext).toBe(request.init.initialContext);
        expect(created.initialMessages).toBe(request.init.prep.allMessages);
      }
    });

    it('keeps independent CLI runs on the default protocol', async () => {
      const { agentRuntimeService, ctx, deps, input } = setupInit();
      await startOperation(deps, ctx, input({}));
      expect(agentRuntimeService.createOperation).toHaveBeenCalledWith(
        expect.objectContaining({ clientProtocol: undefined }),
      );
      expect(agentRuntimeService.getOperationClientProtocol).not.toHaveBeenCalled();
    });

    it('continues safely when the source declaration cannot be read', async () => {
      const { agentRuntimeService, ctx, deps, input } = setupInit();
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      agentRuntimeService.getOperationClientProtocol.mockRejectedValue(new Error('unavailable'));
      await startOperation(deps, ctx, input({ parentOperationId: 'parent' }));
      expect(agentRuntimeService.createOperation).toHaveBeenCalledWith(
        expect.objectContaining({ clientProtocol: undefined }),
      );
      expect(warning).toHaveBeenCalledWith(
        '[startOperation] Failed to inherit message protocol',
        expect.objectContaining({ protocolSource: 'parent' }),
      );
    });
  },
);
