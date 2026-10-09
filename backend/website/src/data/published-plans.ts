import catalog from '../../../app/catalog_defaults.json';
import type {BillingOffer} from '../lib/billing';

// Display only: only the billing API can supply active bindings and checkout IDs.
export const publishedOffers:BillingOffer[]=catalog.products.flatMap(product=>
  Object.entries(product.prices).map(([interval,unit_amount])=>({
    id:`published-${product.id}-${interval}`,name:product.name,plan_id:product.id,
    plan_revision_id:`${product.id}-v1`,currency:catalog.currency,unit_amount:unit_amount!,
    interval:interval as BillingOffer['interval'],monthly_classic_pages:product.monthly_classic_pages,
    service_plan_id:product.service_plan_id,quota_pages:product.quota_pages,quota_validity_days:null,
    hourly_image_limit:null,trial_days:0,trial_classic_pages:0,channels:[],
  })));
export const publishedSubscriptions=publishedOffers.filter(offer=>offer.interval!=='once');
export const publishedPacks=publishedOffers.filter(offer=>offer.interval==='once');
export const publishedModels=catalog.models;
