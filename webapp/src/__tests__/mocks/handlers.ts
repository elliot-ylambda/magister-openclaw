import { http, HttpResponse } from 'msw';

export const handlers = [
  http.post('*/api/chat', () => {
    return new HttpResponse('data: {"type":"text","content":"Hello"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }),
  http.get('*/api/status', () => HttpResponse.json({ status: 'running' })),
  http.post('*/api/provision', () => HttpResponse.json({ success: true })),
  http.post('*/api/destroy', () => HttpResponse.json({ success: true })),
  http.post('https://api.stripe.com/v1/checkout/sessions', () =>
    HttpResponse.json({ id: 'cs_test_mock', url: 'https://checkout.stripe.com/mock' })
  ),
  http.post('https://api.stripe.com/v1/billing_portal/sessions', () =>
    HttpResponse.json({ id: 'bps_test_mock', url: 'https://billing.stripe.com/mock' })
  ),
];
