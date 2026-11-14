import { createElement } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { installTooltips } from '../tooltip.ts';
import { LadderDocument } from './components.ts';
import type { LadderDocumentProps } from './model.ts';
import './styles.css';

const data = document.getElementById('acladder-data');
if (!data?.textContent) throw new Error('Missing server-rendered ladder state');
// The same-origin SSR document emits this inert node after its privacy projection; strings stay React text.
const props: LadderDocumentProps = JSON.parse(data.textContent);
hydrateRoot(document, createElement(LadderDocument, props), { identifierPrefix: 'acladder-' });
installTooltips(document);
