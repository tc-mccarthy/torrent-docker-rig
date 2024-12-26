import amqplib from 'amqplib';

export default async function rabbit_connect(){
    const queue = 'transcode_file_events';
    const conn = await amqplib.connect('amqp://rabbitmq');

    const send_channel = await conn.createChannel();
    await send_channel.assertQueue(queue);

    const receive_channel = await conn.createChannel();
    await receive_channel.assertQueue(queue);

    function send(msg){
        send_channel.sendToQueue(queue, Buffer.from(JSON.stringify(msg)));
    }

    function receive(callback){
        receive_channel.consume(queue, (msg) => {
            callback(JSON.parse(msg.content.toString()));
        }, {prefecth: 1});
    }

    return { send, receive };
}