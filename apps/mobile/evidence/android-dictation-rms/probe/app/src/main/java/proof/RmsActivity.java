package proof;
import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.content.Intent;
import android.content.ComponentName;
import android.speech.*;
import android.util.Log;
import android.widget.*;
public class RmsActivity extends Activity implements RecognitionListener {
 SpeechRecognizer recognizer; TextView status; Handler handler = new Handler();
 public void onCreate(Bundle b) { super.onCreate(b); status=new TextView(this); status.setText("R1 Google recognizer raw RMS"); setContentView(status); requestPermissions(new String[]{"android.permission.RECORD_AUDIO"},1); handler.postDelayed(()->start(),2000); }
 void start(){
 recognizer=SpeechRecognizer.createSpeechRecognizer(this, new ComponentName("com.google.android.tts","com.google.android.apps.speech.tts.googletts.service.GoogleTTSRecognitionService")); recognizer.setRecognitionListener(this);
 Intent intent=new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH); intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM); intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE,"en-US"); intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS,true); intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS,20000L); try {
 android.os.ParcelFileDescriptor[] pipe=android.os.ParcelFileDescriptor.createPipe();
 android.os.ParcelFileDescriptor source=pipe[0];
 new Thread(()->{try(java.io.FileInputStream input=new java.io.FileInputStream("/data/local/tmp/speech.pcm"); java.io.FileOutputStream output=new android.os.ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {byte[] data=new byte[320]; int n;while((n=input.read(data))>0){output.write(data,0,n);Thread.sleep(10);}}catch(Exception e){Log.i("R1RMS","PIPE "+e);}}).start();
 intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE,source);
 intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT,1);
 intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING,android.media.AudioFormat.ENCODING_PCM_16BIT);
 intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE,16000);
 } catch(Exception e){Log.e("R1RMS","FILE",e);}
 recognizer.startListening(intent); Log.i("R1RMS","START");
 }
 public void onReadyForSpeech(Bundle b){Log.i("R1RMS","READY");}
 public void onBeginningOfSpeech(){Log.i("R1RMS","BEGIN");}
 public void onRmsChanged(float v){Log.i("R1RMS","RMS "+v);status.setText("R1 Google recognizer raw RMS: "+v);}
 public void onBufferReceived(byte[] b){}
 public void onEndOfSpeech(){Log.i("R1RMS","END");}
 public void onError(int e){Log.i("R1RMS","ERROR "+e);recognizer.destroy();}
 public void onResults(Bundle b){Log.i("R1RMS","RESULT "+b);recognizer.destroy();}
 public void onPartialResults(Bundle b){Log.i("R1RMS","PARTIAL "+b);}
 public void onEvent(int t,Bundle b){}
}
