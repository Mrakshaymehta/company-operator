// A scripted brain for tests: returns pre-written decisions in order. Lets us test the runtime without a model.
import type { Brain, BrainRequest, BrainResponse } from './types.js';

export class ScriptedBrain implements Brain {
  name = 'scripted';
  calls: BrainRequest[] = [];
  constructor(private script: ((req: BrainRequest, i: number) => unknown)[] | unknown[]) {}
  async decide<T>(req: BrainRequest): Promise<BrainResponse<T>> {
    const i = this.calls.length;
    this.calls.push(req);
    const item = this.script[i];
    if (item === undefined) throw new Error(`ScriptedBrain ran out of decisions at call ${i + 1} (${req.purpose})`);
    const output = (typeof item === 'function' ? (item as (r: BrainRequest, i: number) => unknown)(req, i) : item) as T;
    return { output, ms: 1, model: this.name };
  }
}
