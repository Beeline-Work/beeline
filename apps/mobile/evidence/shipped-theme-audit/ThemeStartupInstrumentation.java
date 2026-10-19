package app.usebeeline;
import android.app.Instrumentation;
import android.os.Bundle;
import android.os.SystemClock;
import expo.modules.notifications.service.delegates.FirebaseMessagingDelegate;
import org.json.JSONObject;
public class ThemeStartupInstrumentation extends Instrumentation {
  private Bundle args;
  public void onCreate(Bundle arguments) { args=arguments; start(); }
  public void onStart() {
    Bundle result=new Bundle();
    try {
      String room=args.getString("room"), workspace=args.getString("workspace"), parent=args.getString("parent");
      if ("notification".equals(args.getString("mode"))) {
        JSONObject data=new JSONObject(); data.put("type","message"); data.put("target","message"); data.put("channelId",room); data.put("roomId",room); data.put("workspaceId",workspace); data.put("messageId",parent);
        Class<?> builderType=Class.forName("com.google.firebase.messaging.RemoteMessage$Builder");
        Object builder=builderType.getConstructor(String.class).newInstance("isolated-theme-proof");
        builderType.getMethod("setMessageId",String.class).invoke(builder,"shipped-theme-cold");
        builderType.getMethod("addData",String.class,String.class).invoke(builder,"title","Shipped theme startup");
        builderType.getMethod("addData",String.class,String.class).invoke(builder,"message","Open the isolated call");
        builderType.getMethod("addData",String.class,String.class).invoke(builder,"body",data.toString());
        Object message=builderType.getMethod("build").invoke(builder);
        FirebaseMessagingDelegate.class.getMethod("onMessageReceived",Class.forName("com.google.firebase.messaging.RemoteMessage"))
          .invoke(new FirebaseMessagingDelegate(getTargetContext()),message);
      } else {
        Bundle data=new Bundle(); data.putString("categoryId","beeline-reply");data.putString("channelId",room);data.putString("messageId",parent);
        Bundle content=new Bundle();content.putBundle("data",data);content.putString("body","Isolated startup proof");
        Bundle request=new Bundle();request.putString("identifier","shipped-theme-headless");request.putBundle("content",content);
        Bundle notification=new Bundle();notification.putBundle("request",request);
        Bundle response=new Bundle();response.putString("actionIdentifier","reply");response.putString("userText","Headless theme startup proof");response.putBundle("notification",notification);
        FirebaseMessagingDelegate.Companion.runTaskManagerTasks(getTargetContext().getApplicationContext(),response);
      }
      SystemClock.sleep(12000);result.putString("result","native notification task dispatch completed without an Activity");finish(-1,result);
    } catch(Throwable e){result.putString("error",e.toString());finish(0,result);}
  }
}
