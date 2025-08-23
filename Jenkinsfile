pipeline {
    agent any

    stages {
        stage('Build Image') {
            steps {
                echo "Building image: localhost:8085/geoguesser-quaka:${imageTag}"

                sh "docker build -t localhost:8085/geoguesser-quaka:${imageTag} ."
            }
        }
        stage('Push Image') {
            steps {
                withCredentials([usernamePassword(credentialsId: 'registry-auth', usernameVariable: 'USERNAME', passwordVariable: 'PASSWORD')]) {
                    sh 'docker login localhost:8085 -u $USERNAME -p $PASSWORD'
                    sh "docker push localhost:8085/geoguesser-quaka:${imageTag}"
                }
            }
        }
    }
}
