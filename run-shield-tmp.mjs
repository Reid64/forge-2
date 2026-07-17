import { scanProjectSecurity } from './src/tools/agent-shield.ts';
import { join } from 'node:path';
const projectPath = 'C:\\Users\\manag\\Documents\\forge-2';
const excludePaths = [join(projectPath, '.claude', 'skills')];
const report = await scanProjectSecurity(projectPath, { excludePaths });
console.log(JSON.stringify(report, null, 2));
