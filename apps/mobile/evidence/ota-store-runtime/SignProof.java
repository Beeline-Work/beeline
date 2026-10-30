import java.io.File;
import java.math.BigInteger;
import java.security.KeyPairGenerator;
import java.util.Date;
import java.util.List;
import sun.security.x509.*;
import com.android.apksig.ApkSigner;
public class SignProof {
  public static void main(String[] args) throws Exception {
    var generator = KeyPairGenerator.getInstance("RSA"); generator.initialize(2048);
    var pair = generator.generateKeyPair();
    var info = new X509CertInfo();
    var name = new X500Name("CN=Local compatibility proof");
    info.set(X509CertInfo.VERSION, new CertificateVersion(2));
    info.set(X509CertInfo.SERIAL_NUMBER, new CertificateSerialNumber(BigInteger.ONE));
    info.set(X509CertInfo.ALGORITHM_ID, new CertificateAlgorithmId(AlgorithmId.get("SHA256withRSA")));
    info.set(X509CertInfo.SUBJECT, name); info.set(X509CertInfo.ISSUER, name);
    info.set(X509CertInfo.KEY, new CertificateX509Key(pair.getPublic()));
    info.set(X509CertInfo.VALIDITY, new CertificateValidity(new Date(0), new Date(4102444800000L)));
    var cert = new X509CertImpl(info); cert.sign(pair.getPrivate(), "SHA256withRSA");
    var signer = new ApkSigner.SignerConfig.Builder("proof", pair.getPrivate(), List.of(cert)).build();
    new ApkSigner.Builder(List.of(signer)).setInputApk(new File(args[0])).setOutputApk(new File(args[1])).build().sign();
  }
}
