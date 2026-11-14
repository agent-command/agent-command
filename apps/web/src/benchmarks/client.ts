import { createElement } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { BenchmarkDocument } from './components.ts';
import type { BenchmarkDocumentProps } from './model.ts';
import './styles.css';

const data = document.getElementById('acbench-data');
if (!data?.textContent) throw new Error('Missing server-rendered benchmark state');
// This inert node is emitted by the same-origin SSR document after the publication privacy/release projection.
// Strings remain React text on both sides; none are interpreted as HTML or chart markup.
const props: BenchmarkDocumentProps = JSON.parse(data.textContent);
hydrateRoot(document, createElement(BenchmarkDocument, props), { identifierPrefix: 'acbench-' });
