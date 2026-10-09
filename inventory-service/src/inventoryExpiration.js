const pool = require('./db');
const logger = require('./logger');
const crypto = require('crypto');
let timer, running = false;
async function releaseExpiredReservations() {
 if(running) return; running=true;
 let client;
 try {
  client=await pool.connect();
  const orders=await client.query("SELECT DISTINCT order_id FROM reservations WHERE status='PENDING' AND expires_at<=NOW() ORDER BY order_id");
  for(const {order_id:orderId} of orders.rows) {
   await client.query('BEGIN');
   await client.query('SELECT pg_advisory_xact_lock($1)',[orderId]);
   const expired=await client.query("UPDATE reservations SET status='EXPIRED' WHERE order_id=$1 AND status='PENDING' AND expires_at<=NOW() RETURNING *",[orderId]);
   for(const r of expired.rows) await client.query('UPDATE inventory SET quantity=quantity+$1,updated_at=NOW() WHERE product_id=$2',[r.quantity,r.product_id]);
   if(expired.rows.length) {
    const active=await client.query("SELECT 1 FROM reservations WHERE order_id=$1 AND status IN ('PENDING','CONFIRMED')",[orderId]);
    await client.query('INSERT INTO outbox_events(event_type,payload) VALUES($1,$2)',['inventory_expired',JSON.stringify({eventId:crypto.randomUUID(),orderId,allInactive:active.rows.length===0,reservations:expired.rows})]);
   }
   await client.query('COMMIT');
  }
 } catch(error) {if(client) await client.query('ROLLBACK').catch(()=>{});logger.error('Reservation expiration failed',{error:error.message});}
 finally {if(client)client.release();running=false;}
}
function startInventoryExpirationWorker(){if(!timer)timer=setInterval(releaseExpiredReservations,Number(process.env.INVENTORY_EXPIRATION_INTERVAL_MS)||60000);}
async function stopInventoryExpirationWorker(){clearInterval(timer);timer=null;while(running)await new Promise(r=>setTimeout(r,25));}
module.exports={releaseExpiredReservations,startInventoryExpirationWorker,stopInventoryExpirationWorker};
