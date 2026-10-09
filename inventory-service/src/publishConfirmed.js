// Publisher confirms alone do not prove that a routing key reached a queue.
async function publishConfirmed(channel, routingKey, payload) {
  let returned = false;
  const messageId = payload.eventId || `${routingKey}:${payload.orderId}`;
  const onReturn = message => {if(message.properties.messageId === messageId) returned = true;};
  channel.on('return', onReturn);
  try {
    channel.publish('app.events', routingKey, Buffer.from(JSON.stringify(payload)), {
      persistent: true, mandatory: true, contentType: 'application/json', messageId,
    });
    await channel.waitForConfirms();
    if(returned) throw Object.assign(new Error('Event has no bound destination queue'),{code:'UNROUTABLE_EVENT'});
  } finally {channel.removeListener('return',onReturn);}
}
module.exports = {publishConfirmed};
