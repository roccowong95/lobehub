import { describe, expect, it } from 'vitest';

import type { OpenAIChatMessage } from '../../../types';
import { convertOpenAIResponseInputs } from './inputs';

const toolCall = {
  function: { arguments: '{}', name: 'getCommandOutput' },
  id: 'call-progress',
  type: 'function',
} satisfies NonNullable<OpenAIChatMessage['tool_calls']>[number];

const toolOutput: OpenAIChatMessage = {
  content: 'Command is still running.',
  role: 'tool',
  tool_call_id: toolCall.id,
};

const expectedCall = {
  arguments: '{}',
  call_id: toolCall.id,
  name: 'getCommandOutput',
  type: 'function_call',
};

const expectedOutput = {
  call_id: toolCall.id,
  output: toolOutput.content,
  type: 'function_call_output',
};

describe('Responses tool-call commentary history', () => {
  it('retains already shown commentary before the paired tool call and output', async () => {
    const result = await convertOpenAIResponseInputs(
      [
        {
          content: 'The container is ready; the base image is still downloading.',
          model: 'gpt-6-astra',
          provider: 'custom',
          role: 'assistant',
          tool_calls: [toolCall],
        },
        toolOutput,
      ],
      { strictToolPairing: true },
    );

    expect(result).toEqual([
      {
        content: 'The container is ready; the base image is still downloading.',
        role: 'assistant',
      },
      expectedCall,
      expectedOutput,
    ]);
  });

  it('keeps reasoning, multipart commentary and multiple tool calls in order', async () => {
    const result = await convertOpenAIResponseInputs(
      [
        {
          content: [
            { text: 'Checking the existing task.', type: 'text' },
            { image_url: { url: 'https://example.com/image.png' }, type: 'image_url' },
            { text: '', type: 'text' },
            { text: 'Waiting for the result.', type: 'text' },
          ],
          reasoning: { content: 'Need the latest task state.' },
          role: 'assistant',
          tool_calls: [
            toolCall,
            { function: { arguments: 'read()', name: 'exec' }, id: 'custom-1', type: 'custom' },
          ],
        },
        toolOutput,
        { content: 'Done.', role: 'tool', tool_call_id: 'custom-1' },
      ],
      { strictToolPairing: true },
    );

    expect(result).toEqual([
      {
        summary: [{ text: 'Need the latest task state.', type: 'summary_text' }],
        type: 'reasoning',
      },
      {
        content: 'Checking the existing task.\n\nWaiting for the result.',
        role: 'assistant',
      },
      expectedCall,
      { call_id: 'custom-1', input: 'read()', name: 'exec', type: 'custom_tool_call' },
      expectedOutput,
      { call_id: 'custom-1', output: 'Done.', type: 'custom_tool_call_output' },
    ]);
  });

  it('retains commentary even when strict pairing removes its unanswered tool call', async () => {
    expect(
      await convertOpenAIResponseInputs(
        [
          {
            content: 'I have already started checking.',
            role: 'assistant',
            tool_calls: [toolCall],
          },
        ],
        { strictToolPairing: true },
      ),
    ).toEqual([{ content: 'I have already started checking.', role: 'assistant' }]);
  });

  it.each<{ content: OpenAIChatMessage['content'] }>([
    { content: '' },
    { content: [] },
    { content: [{ text: '', type: 'text' }] },
  ])('does not add an empty commentary message for $content', async ({ content }) => {
    expect(
      await convertOpenAIResponseInputs(
        [{ content, role: 'assistant', tool_calls: [toolCall] }, toolOutput],
        { strictToolPairing: true },
      ),
    ).toEqual([expectedCall, expectedOutput]);
  });
});
