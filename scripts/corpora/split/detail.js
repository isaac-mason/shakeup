import { summarise } from './shared-dynamic.js';
export const detailOf = (rows) => `detail(${summarise(rows)})`;
