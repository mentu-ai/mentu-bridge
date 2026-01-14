/**
 * Workflow Orchestrator v1.1
 *
 * Executes V4.1 workflow instances for Dual Triad bug investigation.
 * Polls workflow_instances table, spawns claude-code agents per step,
 * and manages step state progression.
 *
 * v1.1: Added resolve() function for memory content resolution
 *
 * Runs as daemon in mentu-bridge, polling every 10 seconds.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { spawn } from "child_process";
import * as path from "path";

interface WorkflowInstance {
  id: string;
  workflow_id: string;
  workflow_version: number;
  parameters: Record<string, unknown>;
  state: string;
  step_states: Record<string, StepStatus>;
  created_at: string;
  updated_at: string;
}

interface StepStatus {
  state: string;
  commitment_id?: string;
  outcome?: string;
  activated_at?: string;
  completed_at?: string;
  error?: string;
  output?: Record<string, unknown>;
}

interface WorkflowDefinition {
  name: string;
  version: number;
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  parameters?: Record<string, unknown>;
}

interface WorkflowStep {
  id: string;
  type: string;
  name: string;
  input?: { body?: string; commitment_id?: string };
  author_type?: string;
  model?: string;
  isolation?: string;
  timeout_seconds?: number;
  output_contract?: Record<string, unknown>;
}

interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;
  description?: string;
}

export class WorkflowOrchestrator {
  private supabase: SupabaseClient;
  private pollInterval = 10000; // 10 seconds
  private pollTimer?: ReturnType<typeof setInterval>;
  private isRunning = false;
  private workspaceId: string;
  private workspacePath: string;

  constructor(config: {
    supabaseUrl: string;
    supabaseKey: string;
    workspaceId: string;
    workspacePath: string;
  }) {
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
    this.workspaceId = config.workspaceId;
    this.workspacePath = config.workspacePath;
  }

  /**
   * Start the orchestrator daemon
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log("[WorkflowOrchestrator] Starting daemon (polling every 10s)");

    this.pollTimer = setInterval(() => {
      this.pollAndExecute().catch((err) => {
        console.error("[WorkflowOrchestrator] Poll error:", err);
      });
    }, this.pollInterval);
  }

  /**
   * Stop the orchestrator daemon
   */
  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.isRunning = false;
    console.log("[WorkflowOrchestrator] Daemon stopped");
  }

  /**
   * Main polling loop: find next pending step and execute it
   */
  private async pollAndExecute(): Promise<void> {
    const instances = await this.getPendingInstances();

    for (const instance of instances) {
      const workflow = await this.getWorkflowDefinition(instance.workflow_id);
      if (!workflow) continue;

      const nextStep = this.findNextExecutableStep(instance, workflow);
      if (!nextStep) continue;

      console.log(
        `[${instance.id}] Executing step: ${nextStep.id} (${nextStep.name})`
      );

      try {
        await this.executeStep(instance, nextStep, workflow);
      } catch (err) {
        console.error(`[${instance.id}] Step ${nextStep.id} failed:`, err);
        await this.updateStepStatus(instance.id, nextStep.id, {
          state: "failed",
          error: String(err),
          completed_at: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Get all pending/running workflow instances
   */
  private async getPendingInstances(): Promise<WorkflowInstance[]> {
    const { data, error } = await this.supabase
      .from("workflow_instances")
      .select("*")
      
      .in("state", ["pending", "running"])
      .order("created_at", { ascending: true })
      .limit(10);

    if (error) {
      console.error("[WorkflowOrchestrator] Failed to fetch instances:", error);
      return [];
    }

    return (data as WorkflowInstance[]) || [];
  }

  /**
   * Get workflow definition from Supabase
   */
  private async getWorkflowDefinition(
    workflowId: string
  ): Promise<WorkflowDefinition | null> {
    const { data, error } = await this.supabase
      .from("workflows")
      .select("definition")
      .eq("id", workflowId)
      .single();

    if (error) {
      console.error("[WorkflowOrchestrator] Failed to fetch workflow:", error);
      return null;
    }

    return (data as { definition: WorkflowDefinition }).definition || null;
  }

  /**
   * Find the next executable step using DAG traversal
   */
  private findNextExecutableStep(
    instance: WorkflowInstance,
    workflow: WorkflowDefinition
  ): WorkflowStep | null {
    // Find a step that is pending (not started yet)
    for (const step of workflow.steps) {
      const status = instance.step_states[step.id];

      if (!status) {
        // Not started yet - check if dependencies are satisfied
        if (this.areDependenciesSatisfied(step, instance, workflow)) {
          return step;
        }
      } else if (status.state === "pending") {
        // Already pending - can execute
        return step;
      }
    }

    return null;
  }

  /**
   * Check if a step's dependencies are satisfied
   */
  private areDependenciesSatisfied(
    step: WorkflowStep,
    instance: WorkflowInstance,
    workflow: WorkflowDefinition
  ): boolean {
    // Find incoming edges
    const incomingEdges = (workflow.edges || []).filter((e) => e.to === step.id);

    if (incomingEdges.length === 0) {
      // No dependencies - this is a start step
      return true;
    }

    // Check if all dependencies are completed
    for (const edge of incomingEdges) {
      const sourceStep = workflow.steps.find((s) => s.id === edge.from);
      if (!sourceStep) continue;

      const sourceStatus = instance.step_states[sourceStep.id];
      if (!sourceStatus || sourceStatus.state !== "completed") {
        return false;
      }

      // If edge has condition, evaluate it
      if (edge.condition) {
        if (!this.evaluateCondition(edge.condition, instance.step_states)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Evaluate a condition like "{{steps.auditor.output.decision}} == 'approved'"
   */
  private evaluateCondition(
    condition: string,
    stepStates: Record<string, StepStatus>
  ): boolean {
    // Simple condition evaluation
    // In production, use a proper expression evaluator
    try {
      // Replace {{steps.X.output.Y}} with actual values
      let expr = condition;

      const regex = /\{\{steps\.(\w+)\.output\.(\w+)\}\}/g;
      expr = expr.replace(regex, (match, stepId, field) => {
        const output = stepStates[stepId]?.output as Record<string, unknown>;
        if (!output) return "undefined";
        const val = output[field];
        return typeof val === "string" ? `"${val}"` : String(val);
      });

      // Evaluate
      return Function(`"use strict"; return (${expr})`)();
    } catch (err) {
      console.error("[WorkflowOrchestrator] Condition eval error:", err);
      return false;
    }
  }

  /**
   * Execute a single workflow step
   */
  private async executeStep(
    instance: WorkflowInstance,
    step: WorkflowStep,
    workflow: WorkflowDefinition
  ): Promise<void> {
    // Update step status to "running"
    await this.updateStepStatus(instance.id, step.id, {
      state: "running",
      activated_at: new Date().toISOString(),
    });

    // Resolve template placeholders in step body (now async for memory resolution)
    const resolvedBody = await this.resolvePlaceholders(
      step.input?.body || "",
      instance.parameters,
      instance.step_states
    );

    // Build claude-code command based on step type
    const model = (step.model || "claude-sonnet-4-5").replace(
      "claude-",
      "--model "
    );

    // Call claude-code in headless mode
    const output = await this.spawnClaude({
      model,
      prompt: resolvedBody,
      timeout: step.timeout_seconds || 600,
      workingDirectory: this.workspacePath,
    });

    // Validate output against contract
    if (step.output_contract && output) {
      const validation = this.validateOutput(
        output,
        step.output_contract as Record<string, unknown>
      );
      if (!validation.valid) {
        throw new Error(`Output validation failed: ${validation.error}`);
      }
    }

    // Update step status to "completed"
    await this.updateStepStatus(instance.id, step.id, {
      state: "completed",
      outcome: output ? "success" : "empty",
      output: output ?? undefined,
      
      completed_at: new Date().toISOString(),
    });
  }

  /**
   * Resolve memory content by ID from operations table
   * v1.1: New method for memory resolution
   */
  private async resolveMemory(memoryId: string): Promise<string> {
    try {
      const { data, error } = await this.supabase
        .from("operations")
        .select("payload")
        .eq("id", memoryId)
        .single();

      if (error || !data) {
        console.error(`[WorkflowOrchestrator] Failed to resolve memory ${memoryId}:`, error);
        return `<<Memory ${memoryId} not found>>`;
      }

      const payload = data.payload as { body?: string; kind?: string };
      return payload.body || JSON.stringify(payload);
    } catch (err) {
      console.error(`[WorkflowOrchestrator] Memory resolution error:`, err);
      return `<<Error resolving ${memoryId}>>`;
    }
  }

  /**
   * Resolve template placeholders like {{parameters.bug_memory_id}} and {{resolve(X)}}
   * v1.1: Now async to support memory resolution
   */
  private async resolvePlaceholders(
    body: string,
    parameters: Record<string, unknown>,
    stepStates: Record<string, StepStatus>
  ): Promise<string> {
    let result = body;

    // Replace {{parameters.X}}
    result = result.replace(/\{\{parameters\.(\w+)\}\}/g, (match, key) => {
      const val = parameters[key];
      return typeof val === "string" ? val : JSON.stringify(val);
    });

    // Replace {{steps.X.output.Y}}
    result = result.replace(
      /\{\{steps\.(\w+)\.output\.(\w+)\}\}/g,
      (match, stepId, field) => {
        const output = stepStates[stepId]?.output as Record<string, unknown>;
        if (!output) return "<<missing>>";
        const val = output[field];
        return typeof val === "string"
          ? val
          : JSON.stringify(val).substring(0, 500);
      }
    );

    // Replace {{resolve(parameters.X)}} with resolved memory content
    // v1.1: New pattern for memory resolution
    const resolvePattern = /\{\{resolve\(parameters\.(\w+)\)\}\}/g;
    const resolveMatches = [...result.matchAll(resolvePattern)];
    
    for (const match of resolveMatches) {
      const paramKey = match[1];
      const memoryId = parameters[paramKey] as string;
      if (memoryId && memoryId.startsWith("mem_")) {
        const memoryContent = await this.resolveMemory(memoryId);
        result = result.replace(match[0], memoryContent);
      } else {
        result = result.replace(match[0], `<<Invalid memory reference: ${paramKey}>>`);
      }
    }

    return result;
  }

  /**
   * Spawn claude-code agent in headless mode
   */
  private spawnClaude(config: {
    model: string;
    prompt: string;
    timeout: number;
    workingDirectory: string;
  }): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      const claudePath = path.join(
        process.env.HOME || "/Users/rashid",
        "claude-code-app",
        "run-claude.sh"
      );

      let stdout = "";
      let stderr = "";

      const proc = spawn("bash", [claudePath, config.model, "-p"], {
        cwd: config.workingDirectory,
        timeout: config.timeout * 1000,
      });

      proc.stdin?.write(config.prompt);
      proc.stdin?.end();

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        try {
          if (code !== 0) {
            reject(new Error(`Claude exit code: ${code}\n${stderr}`));
            return;
          }

          // Extract JSON from output
          const jsonMatch = stdout.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            resolve(null);
            return;
          }

          const output = JSON.parse(jsonMatch[0]);
          resolve(output);
        } catch (err) {
          reject(new Error(`Failed to parse Claude output: ${err}`));
        }
      });

      proc.on("error", (err) => {
        reject(err);
      });
    });
  }

  /**
   * Simple JSON schema validation
   */
  private validateOutput(
    output: Record<string, unknown>,
    schema: Record<string, unknown>
  ): { valid: boolean; error?: string } {
    // In production, use ajv or similar for full JSON Schema validation
    if (schema.required) {
      const required = schema.required as string[];
      for (const field of required) {
        if (!(field in output)) {
          return { valid: false, error: `Missing required field: ${field}` };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Update step status in database
   */
  private async updateStepStatus(
    instanceId: string,
    stepId: string,
    status: Partial<StepStatus>
  ): Promise<void> {
    // Fetch current instance
    const { data: instances, error: fetchErr } = await this.supabase
      .from("workflow_instances")
      .select("step_states")
      .eq("id", instanceId)
      .single();

    if (fetchErr) {
      console.error("[WorkflowOrchestrator] Fetch instance error:", fetchErr);
      return;
    }

    const stepStates = (
      instances as { step_states: Record<string, StepStatus> }
    ).step_states || {};

    stepStates[stepId] = { ...stepStates[stepId], ...status };

    // Update instance
    const { error: updateErr } = await this.supabase
      .from("workflow_instances")
      .update({
        step_states: stepStates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", instanceId);

    if (updateErr) {
      console.error("[WorkflowOrchestrator] Update error:", updateErr);
    }
  }
}
