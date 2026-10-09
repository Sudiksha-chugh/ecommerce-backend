const identifierFields = new Set(['eventId','orderId','requestId','operationId','correlationId','userId','productId','reservationId','orderOwnerId','createdBy','order_id','product_id']);
function normalizeIdentifiers(value) {
 if(Array.isArray(value)) return value.map(normalizeIdentifiers);
 if(!value || typeof value !== 'object' || value instanceof Date) return value;
 const result={...value};
 for(const [key,item] of Object.entries(value)) result[key]=identifierFields.has(key) && item != null ? String(item) : normalizeIdentifiers(item);
 return result;
}
module.exports={normalizeIdentifiers};
