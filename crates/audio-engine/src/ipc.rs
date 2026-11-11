use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::{net::UnixStream, sync::mpsc};
use tokio_util::{
    codec::{Framed, LinesCodec},
    sync::CancellationToken,
};

pub async fn connect(
    path: &str,
    stop: CancellationToken,
) -> Result<(mpsc::Sender<Value>, mpsc::Receiver<Result<Value>>)> {
    let socket = UnixStream::connect(path).await?;
    let (mut writer, mut reader) =
        Framed::new(socket, LinesCodec::new_with_max_length(65536)).split();
    let (send, mut outgoing) = mpsc::channel::<Value>(32);
    let (incoming, receive) = mpsc::channel(128);
    let errors = incoming.clone();
    let s = stop.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {_=s.cancelled()=>break,message=outgoing.recv()=>{
                let Some(message)=message else{break};
                if let Err(e)=writer.send(message.to_string()).await {let _=errors.send(Err(e.into())).await;break;}
            }}
        }
    });
    tokio::spawn(async move {
        loop {
            tokio::select! {_=stop.cancelled()=>break,message=reader.next()=>{
                let Some(message)=message else{let _=incoming.send(Err(anyhow::anyhow!("agent disconnected"))).await;break;};
                let value=message.map_err(anyhow::Error::from).and_then(|s|Ok(serde_json::from_str::<Value>(&s)?));
                if incoming.send(value).await.is_err(){break;}
            }}
        }
    });
    Ok((send, receive))
}
