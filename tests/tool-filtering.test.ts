import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentRunner, TOOL_PRESETS } from '../src/agent/runner.js'
import { ToolRegistry, defineTool } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { z } from 'zod'
import type { LLMAdapter, LLMResponse, LLMToolDef } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

const mockAdapter: LLMAdapter = {
  name: 'mock',
  async chat() {
    return {
      id: 'mock-1',
      content: [{ type: 'text', text: 'response' }],
      model: 'mock-model',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    } satisfies LLMResponse
  },
  async *stream() {
    // Not used in these tests
  },
}

// ---------------------------------------------------------------------------
// Test tools
// ---------------------------------------------------------------------------

function createTestTools() {
  const registry = new ToolRegistry()

  // Register test tools that match our presets
  registry.register(defineTool({
    name: 'file_read',
    description: 'Read file',
    inputSchema: z.object({ path: z.string() }),
    execute: async () => ({ data: 'content', isError: false }),
  }))

  registry.register(defineTool({
    name: 'file_write',
    description: 'Write file',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async () => ({ data: 'ok', isError: false }),
  }))

  registry.register(defineTool({
    name: 'file_edit',
    description: 'Edit file',
    inputSchema: z.object({ path: z.string(), oldString: z.string(), newString: z.string() }),
    execute: async () => ({ data: 'ok', isError: false }),
  }))

  registry.register(defineTool({
    name: 'grep',
    description: 'Search text',
    inputSchema: z.object({ pattern: z.string(), path: z.string() }),
    execute: async () => ({ data: 'matches', isError: false }),
  }))

  registry.register(defineTool({
    name: 'bash',
    description: 'Run shell command',
    inputSchema: z.object({ command: z.string() }),
    execute: async () => ({ data: 'output', isError: false }),
  }))

  // Extra tool not in any preset
  registry.register(defineTool({
    name: 'custom_tool',
    description: 'Custom tool',
    inputSchema: z.object({ input: z.string() }),
    execute: async () => ({ data: 'custom', isError: false }),
  }))

  return registry
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tool filtering', () => {
  const registry = createTestTools()
  const executor = new ToolExecutor(registry)

  describe('TOOL_PRESETS', () => {
    it('readonly preset has correct tools', () => {
      expect(TOOL_PRESETS.readonly).toEqual(['file_read', 'grep'])
    })

    it('readwrite preset has correct tools', () => {
      expect(TOOL_PRESETS.readwrite).toEqual(['file_read', 'file_write', 'file_edit', 'grep'])
    })

    it('full preset has correct tools', () => {
      expect(TOOL_PRESETS.full).toEqual(['file_read', 'file_write', 'file_edit', 'grep', 'bash'])
    })
  })

  describe('resolveTools - no filtering', () => {
    it('returns all tools when no filters are set', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual(['bash', 'custom_tool', 'file_edit', 'file_read', 'file_write', 'grep'])
    })
  })

  describe('resolveTools - preset filtering', () => {
    it('readonly preset filters correctly', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        toolPreset: 'readonly',
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual(['file_read', 'grep'])
    })

    it('readwrite preset filters correctly', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        toolPreset: 'readwrite',
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual(['file_edit', 'file_read', 'file_write', 'grep'])
    })

    it('full preset filters correctly', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        toolPreset: 'full',
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual(['bash', 'file_edit', 'file_read', 'file_write', 'grep'])
    })
  })

  describe('resolveTools - allowlist filtering', () => {
    it('allowlist filters correctly', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        allowedTools: ['file_read', 'bash'],
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual(['bash', 'file_read'])
    })

    it('empty allowlist returns no tools', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        allowedTools: [],
      })

      const tools = (runner as any).resolveTools()
      expect(tools).toHaveLength(0)
    })
  })

  describe('resolveTools - denylist filtering', () => {
    it('denylist filters correctly', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        disallowedTools: ['bash', 'custom_tool'],
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual(['file_edit', 'file_read', 'file_write', 'grep'])
    })

    it('empty denylist returns all tools', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        disallowedTools: [],
      })

      const tools = (runner as any).resolveTools()
      expect(tools).toHaveLength(6) // All registered tools
    })
  })

  describe('resolveTools - combined filtering (preset + allowlist + denylist)', () => {
    it('preset + allowlist + denylist work together', () => {
      // Start with readwrite preset: ['file_read', 'file_write', 'file_edit', 'grep']
      // Then allowlist: intersect with ['file_read', 'file_write', 'grep'] = ['file_read', 'file_write', 'grep']
      // Then denylist: subtract ['file_write'] = ['file_read', 'grep']
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        toolPreset: 'readwrite',
        allowedTools: ['file_read', 'file_write', 'grep'],
        disallowedTools: ['file_write'],
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual(['file_read', 'grep'])
    })

    it('preset filters first, then allowlist intersects, then denylist subtracts', () => {
      // Start with readonly preset: ['file_read', 'grep']
      // Allowlist intersect with ['file_read', 'bash']: ['file_read']
      // Denylist subtract ['file_read']: []
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        toolPreset: 'readonly',
        allowedTools: ['file_read', 'bash'],
        disallowedTools: ['file_read'],
      })

      const tools = (runner as any).resolveTools()
      expect(tools).toHaveLength(0)
    })
  })

  describe('resolveTools - validation warnings', () => {
    let consoleWarnSpy: any

    beforeEach(() => {
      consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleWarnSpy.mockRestore()
    })

    it('warns when tool appears in both allowedTools and disallowedTools', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        allowedTools: ['file_read', 'bash'],
        disallowedTools: ['bash', 'grep'],
      })

      ;(runner as any).resolveTools()

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('tool "bash" appears in both allowedTools and disallowedTools')
      )
    })

    it('does not warn when no overlap between allowedTools and disallowedTools', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        allowedTools: ['file_read'],
        disallowedTools: ['bash'],
      })

      ;(runner as any).resolveTools()

      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })
  })
})