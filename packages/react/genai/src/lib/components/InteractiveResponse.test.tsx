import { cleanup, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { InteractiveResponse } from './InteractiveResponse.tsx';

function ParamProbe(props: { param?: string; label?: string }) {
  return (
    <div data-testid="probe">
      {JSON.stringify({ param: props.param, label: props.label })}
    </div>
  );
}

test('rejects an element that declares a sanitizer-clobbered attribute', () => {
  const clobberedElement = {
    name: 'bad-element',
    component: ParamProbe,
    allowedAttributes: ['name', 'label'],
  };

  try {
    expect(() =>
      render(
        <InteractiveResponse elements={[clobberedElement]}>
          {'<bad-element name="state"></bad-element>'}
        </InteractiveResponse>,
      ),
    ).toThrow(/name|reserved/i);
  } finally {
    cleanup();
  }
});

test('top-level custom elements stay wrapped in a bare class-less div', () => {
  // Bare wrappers are part of the public rendering contract. A class or extra
  // layer would prevent consumers from making this structural wrapper
  // layout-transparent.
  const paramElement = {
    name: 'param-probe',
    component: ParamProbe,
    allowedAttributes: ['param', 'label'],
  };

  try {
    render(
      <InteractiveResponse elements={[paramElement]}>
        {'<param-probe param="state"></param-probe>'}
      </InteractiveResponse>,
    );

    const wrapper = screen.getByTestId('probe').parentElement;
    expect(wrapper?.tagName).toBe('DIV');
    expect(wrapper?.hasAttribute('class')).toBe(false);
  } finally {
    cleanup();
  }
});

test('the param attribute reaches the element verbatim through the sanitize pipeline', () => {
  const paramElement = {
    name: 'param-probe',
    component: ParamProbe,
    allowedAttributes: ['param', 'label'],
  };

  try {
    render(
      <InteractiveResponse elements={[paramElement]}>
        {'<param-probe param="state" label="State"></param-probe>'}
      </InteractiveResponse>,
    );

    expect(JSON.parse(screen.getByTestId('probe').textContent ?? '{}')).toEqual(
      { param: 'state', label: 'State' },
    );
  } finally {
    cleanup();
  }
});

test('escaped quotes in a generic attribute survive the rendering pipeline', () => {
  const paramElement = {
    name: 'param-probe',
    component: ParamProbe,
    allowedAttributes: ['param', 'label'],
  };

  try {
    render(
      <InteractiveResponse elements={[paramElement]}>
        {
          '<param-probe label="Revenue by \\"region\\"" param="state"></param-probe>'
        }
      </InteractiveResponse>,
    );

    expect(JSON.parse(screen.getByTestId('probe').textContent ?? '{}')).toEqual(
      { param: 'state', label: 'Revenue by "region"' },
    );
  } finally {
    cleanup();
  }
});
