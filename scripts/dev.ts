// Starts the pretend company and the operator console together:  pnpm dev
import { startSandbox } from '../sandbox/server.js';
import { consoleApp } from '../src/console/server.js';
import { config } from '../src/config.js';

await startSandbox();
const port = Number(process.env.CONSOLE_PORT ?? 4000);
consoleApp().listen(port, () => {
  console.log('Kaira Naturals sandbox: Kaira Books http://localhost:4101 · Kaira Mail http://localhost:4102 · admin http://localhost:4199');
  console.log(`Operator console:       http://localhost:${port}   (brain: Claude ${config.model} via Claude Code${config.headed ? ', visible browser' : ''})`);
});
