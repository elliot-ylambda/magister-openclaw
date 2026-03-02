import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set');
  process.exit(1);
}

const stripe = new Stripe(key);

async function main() {
  const coupon = await stripe.coupons.create({
    name: 'Admin — Internal Use',
    percent_off: 100,
    duration: 'forever',
  });

  console.log('Coupon created successfully!');
  console.log(`  ID: ${coupon.id}`);
  console.log('');
  console.log('Add to webapp/.env.local:');
  console.log(`  STRIPE_ADMIN_COUPON_ID=${coupon.id}`);
}

main().catch((err) => {
  console.error('Failed to create coupon:', err.message);
  process.exit(1);
});
